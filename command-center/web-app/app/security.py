from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from starlette.concurrency import run_in_threadpool


@dataclass(frozen=True)
class Principal:
    subject: str
    roles: frozenset[str]

    def has_any(self, *roles: str) -> bool:
        return bool(self.roles.intersection(roles))


bearer = HTTPBearer(auto_error=False)


@lru_cache(maxsize=1)
def jwks_client() -> PyJWKClient:
    issuer = os.getenv("OIDC_ISSUER", "http://localhost:8080/realms/ashraay").rstrip("/")
    jwks_url = os.getenv(
        "OIDC_JWKS_URL", f"{issuer}/protocol/openid-connect/certs"
    )
    return PyJWKClient(jwks_url, cache_keys=True, lifespan=300)


async def _verify_local_token(token: str, audience: str) -> Principal | None:
    """Verify tokens issued by the built-in citizen/volunteer accounts; None means not a local token."""
    from app.accounts import LOCAL_ISSUER, local_public_key

    try:
        unverified_issuer = jwt.decode(token, options={"verify_signature": False}).get("iss")
    except jwt.PyJWTError:
        return None
    if unverified_issuer != LOCAL_ISSUER:
        return None
    try:
        claims = jwt.decode(
            token,
            await local_public_key(),
            algorithms=["RS256"],
            audience=audience,
            issuer=LOCAL_ISSUER,
            options={"require": ["exp", "iat", "sub", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=401,
            detail="Access token is invalid or expired.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    roles = (claims.get("realm_access") or {}).get("roles")
    if not isinstance(roles, list) or not all(isinstance(role, str) for role in roles):
        raise HTTPException(status_code=401, detail="Access token roles are invalid.")
    return Principal(subject=claims["sub"], roles=frozenset(roles))


async def verify_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="Bearer access token required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    issuer = os.getenv("OIDC_ISSUER", "http://localhost:8080/realms/ashraay").rstrip("/")
    audience = os.getenv("OIDC_AUDIENCE", "ashraay-api")
    local_principal = await _verify_local_token(credentials.credentials, audience)
    if local_principal is not None:
        return local_principal
    try:
        signing_key = await run_in_threadpool(
            jwks_client().get_signing_key_from_jwt, credentials.credentials
        )
        claims = jwt.decode(
            credentials.credentials,
            signing_key.key,
            algorithms=["RS256"],
            audience=audience,
            issuer=issuer,
            options={"require": ["exp", "iat", "sub", "iss", "aud"]},
        )
    except (jwt.PyJWTError, ValueError) as exc:
        raise HTTPException(
            status_code=401,
            detail="Access token is invalid or expired.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    role_claim: object = claims
    for path_part in os.getenv("OIDC_ROLES_CLAIM", "realm_access.roles").split("."):
        role_claim = role_claim.get(path_part) if isinstance(role_claim, dict) else None
    role_claims = role_claim
    if not isinstance(role_claims, list) or not all(
        isinstance(role, str) for role in role_claims
    ):
        raise HTTPException(status_code=401, detail="Access token roles are invalid.")
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject:
        raise HTTPException(status_code=401, detail="Access token subject is invalid.")
    return Principal(subject=subject, roles=frozenset(role_claims))


def require_roles(*allowed_roles: str):
    async def dependency(principal: Principal = Depends(verify_token)) -> Principal:
        if not principal.has_any(*allowed_roles):
            raise HTTPException(status_code=403, detail="Your account is not permitted to do this.")
        return principal

    return dependency
