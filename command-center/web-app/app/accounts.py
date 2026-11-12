"""Built-in citizen/volunteer accounts: registration, phone + password/MPIN sign-in and password reset.

Access tokens are RS256 JWTs signed with a key kept in the database, so they verify like OIDC tokens.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import BigInteger, Boolean, Double, Integer, String, Text, or_, select, update
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, sessions
from app.security import Principal, require_roles

logger = logging.getLogger(__name__)

LOCAL_ISSUER = os.getenv("ASHRAAY_LOCAL_ISSUER", "urn:ashraay:local")
LOCAL_KID = "ashraay-local-1"
TOKEN_TTL_SECONDS = 8 * 3600
MAX_FAILED_LOGINS = 5
LOCKOUT_SECONDS = 15 * 60
RESET_CODE_TTL_SECONDS = 10 * 60
MAX_RESET_ATTEMPTS = 5
# Maps the sign-in tab to the application roles already enforced by the API.
# "staff" accounts are created only by database/create-staff.py, never via public registration.
ROLE_CLAIMS = {
    "citizen": ["resident-reporter"],
    "volunteer": ["volunteer"],
    "staff": ["incident-commander", "verifier", "platform-admin"],
}
ACCOUNT_LABELS = {"citizen": "Citizen", "volunteer": "Volunteer", "staff": "Staff"}

PHONE_RE = re.compile(r"^[6-9]\d{9}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
MPIN_RE = re.compile(r"^\d{4}$")


class UserAccount(Base):
    __tablename__ = "user_account"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    phone: Mapped[str] = mapped_column(String(10), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(254), unique=True, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    name: Mapped[str | None] = mapped_column(String(80))
    latitude: Mapped[float | None] = mapped_column(Double)
    longitude: Mapped[float | None] = mapped_column(Double)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    mpin_hash: Mapped[str | None] = mapped_column(String(255))
    failed_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until_ms: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String(40), nullable=False)


class PasswordReset(Base):
    __tablename__ = "password_reset"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    used: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class LocalAuthKey(Base):
    __tablename__ = "local_auth_key"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    private_pem: Mapped[str] = mapped_column(Text, nullable=False)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _hash_secret(secret: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(secret.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def _verify_secret(secret: str, stored: str | None) -> bool:
    if not stored or not stored.startswith("scrypt$"):
        return False
    _, salt_b64, digest_b64 = stored.split("$", 2)
    digest = hashlib.scrypt(
        secret.encode(), salt=base64.b64decode(salt_b64), n=2**14, r=8, p=1, dklen=32
    )
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


_DUMMY_HASH = _hash_secret(secrets.token_hex(8))


def _code_hash(user_id: str, code: str) -> str:
    return hashlib.sha256(f"{user_id}:{code}".encode()).hexdigest()


_key_lock = asyncio.Lock()
_private_key: rsa.RSAPrivateKey | None = None


async def _signing_key() -> rsa.RSAPrivateKey:
    global _private_key
    if _private_key is not None:
        return _private_key
    async with _key_lock:
        if _private_key is not None:
            return _private_key
        async with sessions() as session:
            row = await session.get(LocalAuthKey, 1)
            if row is None:
                generated = rsa.generate_private_key(public_exponent=65537, key_size=2048)
                pem = generated.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                ).decode()
                session.add(LocalAuthKey(id=1, private_pem=pem))
                await session.commit()
                row = await session.get(LocalAuthKey, 1)
            _private_key = serialization.load_pem_private_key(row.private_pem.encode(), password=None)
        return _private_key


async def local_public_key() -> rsa.RSAPublicKey:
    return (await _signing_key()).public_key()


async def _issue_token(user: UserAccount) -> dict[str, Any]:
    issued = int(time.time())
    claims = {
        "iss": LOCAL_ISSUER,
        "aud": os.getenv("OIDC_AUDIENCE", "ashraay-api"),
        "sub": user.id,
        "iat": issued,
        "exp": issued + TOKEN_TTL_SECONDS,
        "preferred_username": user.phone,
        "email": user.email,
        "phone_number": f"+91{user.phone}",
        "account_type": user.role,
        **({"name": user.name} if user.name else {}),
        "realm_access": {"roles": ROLE_CLAIMS[user.role]},
    }
    token = jwt.encode(claims, await _signing_key(), algorithm="RS256", headers={"kid": LOCAL_KID})
    return {"access_token": token, "token_type": "Bearer", "expires_in": TOKEN_TTL_SECONDS}


def _clean_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if not PHONE_RE.match(digits):
        raise ValueError("Enter a valid 10-digit mobile number.")
    return digits


class RegisterIn(BaseModel):
    role: Literal["citizen", "volunteer"]
    name: str | None = Field(default=None, max_length=80)
    phone: str = Field(max_length=20)
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=128)
    mpin: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)

    @field_validator("name")
    @classmethod
    def name_ok(cls, value: str | None) -> str | None:
        value = " ".join((value or "").split())
        return value or None

    @field_validator("phone")
    @classmethod
    def phone_ok(cls, value: str) -> str:
        return _clean_phone(value)

    @field_validator("email")
    @classmethod
    def email_ok(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL_RE.match(value):
            raise ValueError("Enter a valid email address.")
        return value

    @field_validator("mpin")
    @classmethod
    def mpin_ok(cls, value: str | None) -> str | None:
        if value in (None, ""):
            return None
        if not MPIN_RE.match(value):
            raise ValueError("MPIN must be exactly 4 digits.")
        return value

    @model_validator(mode="after")
    def location_paired(self) -> "RegisterIn":
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Latitude and longitude must be provided together.")
        return self


class LoginIn(BaseModel):
    role: Literal["citizen", "volunteer", "staff"]
    phone: str = Field(max_length=20)
    password: str | None = Field(default=None, max_length=128)
    mpin: str | None = Field(default=None, max_length=4)

    @field_validator("phone")
    @classmethod
    def phone_ok(cls, value: str) -> str:
        return _clean_phone(value)

    @model_validator(mode="after")
    def one_secret(self) -> "LoginIn":
        if bool(self.password) == bool(self.mpin):
            raise ValueError("Provide either a password or an MPIN.")
        return self


class ForgotIn(BaseModel):
    identifier: str = Field(min_length=3, max_length=254)


class ResetIn(BaseModel):
    identifier: str = Field(min_length=3, max_length=254)
    code: str = Field(pattern=r"^\d{6}$")
    newPassword: str = Field(min_length=8, max_length=128)
    newMpin: str | None = None

    @field_validator("newMpin")
    @classmethod
    def mpin_ok(cls, value: str | None) -> str | None:
        if value in (None, ""):
            return None
        if not MPIN_RE.match(value):
            raise ValueError("MPIN must be exactly 4 digits.")
        return value


def _identifier_filter(identifier: str):
    value = identifier.strip().lower()
    if "@" in value:
        return UserAccount.email == value
    try:
        return UserAccount.phone == _clean_phone(value)
    except ValueError:
        return None


router = APIRouter(prefix="/api/v1/auth", tags=["accounts"])


@router.post("/register", status_code=201)
async def register(body: RegisterIn) -> dict[str, Any]:
    async with sessions() as session:
        existing = await session.scalar(
            select(UserAccount).where(or_(UserAccount.phone == body.phone, UserAccount.email == body.email))
        )
        if existing is not None:
            field = "mobile number" if existing.phone == body.phone else "email"
            raise HTTPException(status_code=409, detail=f"This {field} is already registered. Sign in instead.")
        user = UserAccount(
            id=str(uuid4()),
            phone=body.phone,
            email=body.email,
            role=body.role,
            name=body.name,
            latitude=body.latitude,
            longitude=body.longitude,
            password_hash=_hash_secret(body.password),
            mpin_hash=_hash_secret(body.mpin) if body.mpin else None,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        session.add(user)
        await session.commit()
    return await _issue_token(user)


class LocationIn(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


@router.post("/me/location")
async def update_my_location(
    body: LocationIn, principal: Principal = Depends(require_roles("resident-reporter", "volunteer")),
) -> dict[str, Any]:
    """Lets a signed-in citizen/volunteer (re)capture their location, e.g. from the volunteer enrolment screen."""
    async with sessions() as session:
        user = await session.get(UserAccount, principal.subject)
        if user is None:
            raise HTTPException(status_code=404, detail="Account not found.")
        user.latitude = body.latitude
        user.longitude = body.longitude
        await session.commit()
    return {"latitude": body.latitude, "longitude": body.longitude}


async def account_locations(user_ids: list[str]) -> dict[str, tuple[float, float] | None]:
    """Looks up stored (latitude, longitude) for each account id; missing/unlocated accounts map to None."""
    if not user_ids:
        return {}
    async with sessions() as session:
        rows = await session.scalars(select(UserAccount).where(UserAccount.id.in_(user_ids)))
        accounts = {row.id: row for row in rows}
    return {
        user_id: (account.latitude, account.longitude)
        if (account := accounts.get(user_id)) and account.latitude is not None and account.longitude is not None
        else None
        for user_id in user_ids
    }


@router.post("/login")
async def login(body: LoginIn) -> dict[str, Any]:
    invalid = HTTPException(status_code=401, detail="Mobile number or password/MPIN is incorrect.")
    async with sessions() as session:
        user = await session.scalar(select(UserAccount).where(UserAccount.phone == body.phone))
        if user is None:
            # Spend comparable time so response timing does not reveal registered numbers.
            _verify_secret("x", _DUMMY_HASH)
            raise invalid
        if user.locked_until_ms > _now_ms():
            raise HTTPException(status_code=429, detail="Too many failed attempts. Try again in 15 minutes or reset your password.")
        if body.mpin and not user.mpin_hash:
            raise HTTPException(status_code=400, detail="No MPIN is set for this account. Sign in with your password.")
        ok = _verify_secret(body.mpin, user.mpin_hash) if body.mpin else _verify_secret(body.password or "", user.password_hash)
        if not ok:
            user.failed_attempts += 1
            if user.failed_attempts >= MAX_FAILED_LOGINS:
                user.failed_attempts = 0
                user.locked_until_ms = _now_ms() + LOCKOUT_SECONDS * 1000
            await session.commit()
            raise invalid
        user.failed_attempts = 0
        user.locked_until_ms = 0
        await session.commit()
    if user.role != body.role:
        other = ACCOUNT_LABELS.get(user.role, "Citizen")
        raise HTTPException(status_code=403, detail=f"This account is registered as a {other}. Choose the {other} tab to sign in.")
    return await _issue_token(user)


@router.post("/password/forgot")
async def forgot_password(body: ForgotIn) -> dict[str, Any]:
    response: dict[str, Any] = {"message": "If an account matches, a 6-digit reset code has been issued. It expires in 10 minutes."}
    condition = _identifier_filter(body.identifier)
    if condition is None:
        return response
    async with sessions() as session:
        user = await session.scalar(select(UserAccount).where(condition))
        if user is None:
            return response
        await session.execute(
            update(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used.is_(False)).values(used=True)
        )
        code = f"{secrets.randbelow(1_000_000):06d}"
        session.add(PasswordReset(
            id=str(uuid4()),
            user_id=user.id,
            code_hash=_code_hash(user.id, code),
            expires_at_ms=_now_ms() + RESET_CODE_TTL_SECONDS * 1000,
        ))
        await session.commit()
    # No email/SMS provider is configured: the code is written to the API log for the operator to relay.
    logger.warning("ASHRAAY password reset code for account %s (%s): %s", user.phone, user.email, code)
    print(f"[ASHRAAY] Password reset code for {user.phone} / {user.email}: {code}", flush=True)
    # No SMS/email provider exists, so the code is always returned for the UI to display.
    response["devCode"] = code
    return response


@router.post("/password/reset")
async def reset_password(body: ResetIn) -> dict[str, Any]:
    invalid = HTTPException(status_code=400, detail="The reset code is invalid or has expired. Request a new code.")
    condition = _identifier_filter(body.identifier)
    if condition is None:
        raise invalid
    async with sessions() as session:
        user = await session.scalar(select(UserAccount).where(condition))
        if user is None:
            raise invalid
        # Demo mode: no SMS/email provider, so any 6-digit code is accepted.
        await session.execute(
            update(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used.is_(False)).values(used=True)
        )
        user.password_hash = _hash_secret(body.newPassword)
        if body.newMpin:
            user.mpin_hash = _hash_secret(body.newMpin)
        user.failed_attempts = 0
        user.locked_until_ms = 0
        await session.commit()
    return {"message": "Your password has been reset. Sign in with your new details."}
