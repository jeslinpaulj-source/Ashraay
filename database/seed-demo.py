"""Seed fake demo data: citizen incident reports and multiple volunteers clustered in one city.

Mimics the real app flow entirely through the running HTTP API (no direct DB writes):
  1. Pushes simulator hazard inputs for the chosen city, so Agent 1 will raise a "high" alert
     the next time someone clicks Scan for that city.
  2. Registers volunteer accounts, sets their location, enrols them, verifies them (as staff),
     and marks them available.
  3. Registers citizen accounts and submits incident reports near the same location.

Usage (after start-server.bat is running):
  .venv\\Scripts\\python.exe database\\seed-demo.py --staff-phone 9876543210
  (prompts for the staff password; staff account must already exist, see create-staff.py)

Safe to re-run: existing demo accounts are reused via login instead of failing on 409.
"""
from __future__ import annotations

import argparse
import getpass
import math
import random
import sys
import uuid

import httpx

CITIES = {
    "bengaluru": {"name": "Bengaluru", "lat": 12.9716, "lon": 77.5946},
    "kochi": {"name": "Kochi", "lat": 9.9312, "lon": 76.2673},
    "thiruvananthapuram": {"name": "Thiruvananthapuram", "lat": 8.5241, "lon": 76.9366},
    "chennai": {"name": "Chennai", "lat": 13.0827, "lon": 80.2707},
    "mumbai": {"name": "Mumbai", "lat": 19.076, "lon": 72.8777},
    "delhi": {"name": "New Delhi", "lat": 28.6139, "lon": 77.209},
    "kolkata": {"name": "Kolkata", "lat": 22.5726, "lon": 88.3639},
}
VOLUNTEER_SKILLS = [
    "rescue", "first-aid", "boat-handling", "swimming", "driving", "logistics", "counselling", "translation",
]
NEEDS = ["evacuation", "drinking-water", "medical", "food", "shelter"]
DEMO_PASSWORD = "Demo@12345"


def jitter(lat: float, lon: float, radius_km: float) -> tuple[float, float]:
    """Random point within radius_km of (lat, lon) so seeded accounts aren't all on the same spot."""
    distance_km = random.uniform(0, radius_km)
    bearing = random.uniform(0, 2 * math.pi)
    d_lat = (distance_km / 111.0) * math.cos(bearing)
    d_lon = (distance_km / (111.0 * math.cos(math.radians(lat)))) * math.sin(bearing)
    return round(lat + d_lat, 6), round(lon + d_lon, 6)


def idem() -> str:
    return str(uuid.uuid4())


def register_or_login(client: httpx.Client, *, role: str, phone: str, email: str, name: str,
                       lat: float | None = None, lon: float | None = None) -> str:
    payload = {"role": role, "name": name, "phone": phone, "email": email, "password": DEMO_PASSWORD}
    if lat is not None:
        payload.update(latitude=lat, longitude=lon)
    response = client.post("/api/v1/auth/register", json=payload)
    if response.status_code == 409:
        # Account already exists from a previous run of this script - sign in instead.
        response = client.post("/api/v1/auth/login", json={"role": role, "phone": phone, "password": DEMO_PASSWORD})
    response.raise_for_status()
    return response.json()["access_token"]


def seed_volunteers(client: httpx.Client, *, count: int, city: dict, radius_km: float, staff_token: str | None) -> None:
    for i in range(1, count + 1):
        phone, email = f"95550{i:05d}", f"demo.volunteer{i}@example.com"
        lat, lon = jitter(city["lat"], city["lon"], radius_km)
        token = register_or_login(client, role="volunteer", phone=phone, email=email, name=f"Demo Volunteer {i}", lat=lat, lon=lon)
        auth = {"Authorization": f"Bearer {token}"}
        # Re-capture location in case the account already existed from a previous run.
        client.post("/api/v1/auth/me/location", json={"latitude": lat, "longitude": lon}, headers=auth).raise_for_status()
        skills = random.sample(VOLUNTEER_SKILLS, k=random.randint(1, 3))
        body = {
            "displayName": f"Demo Volunteer {i}",
            "skills": skills,
            "languages": ["en"],
            "area": f"Near {city['name']}",
            "consent": True,
        }
        profile = client.post("/api/v1/volunteers/me", json=body, headers={**auth, "Idempotency-Key": idem()}).json()
        if staff_token:
            client.post(
                f"/api/v1/volunteers/{profile['id']}/verify",
                json={"action": "verify", "reason": "Demo seed data"},
                headers={"Authorization": f"Bearer {staff_token}", "Idempotency-Key": idem()},
            ).raise_for_status()
            client.post(
                "/api/v1/volunteers/me/availability",
                json={"available": True},
                headers={**auth, "Idempotency-Key": idem()},
            ).raise_for_status()
        print(f"  volunteer {i}: {profile['displayName']} ({lat}, {lon}) skills={skills} verified={bool(staff_token)}")


def seed_citizen_reports(client: httpx.Client, *, count: int, city: dict, radius_km: float) -> None:
    for i in range(1, count + 1):
        phone, email = f"96550{i:05d}", f"demo.citizen{i}@example.com"
        token = register_or_login(client, role="citizen", phone=phone, email=email, name=f"Demo Citizen {i}")
        lat, lon = jitter(city["lat"], city["lon"], radius_km)
        body = {
            "description": f"Water is rising fast near our street and we need help (demo citizen {i}).",
            "landmark": f"Near {city['name']} ward {i}",
            "people": random.randint(1, 12),
            "consent": True,
            "incidentType": "flood",
            "needs": random.sample(NEEDS, k=random.randint(1, 3)),
            "latitude": lat,
            "longitude": lon,
        }
        headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": idem()}
        client.post("/api/v1/reports", json=body, headers=headers).raise_for_status()
        print(f"  incident {i}: {body['landmark']} ({lat}, {lon}) needs={body['needs']}")


CHECKIN_STATUS_CYCLE = ["need_help", "need_help", "at_risk", "at_risk", "safe"]


def seed_checkins(client: httpx.Client, *, count: int, city: dict, radius_km: float) -> None:
    for i in range(1, count + 1):
        phone, email = f"97550{i:05d}", f"demo.resident{i}@example.com"
        token = register_or_login(client, role="citizen", phone=phone, email=email, name=f"Demo Resident {i}")
        lat, lon = jitter(city["lat"], city["lon"], radius_km)
        status = CHECKIN_STATUS_CYCLE[(i - 1) % len(CHECKIN_STATUS_CYCLE)]
        body = {
            "status": status,
            "landmark": f"Near {city['name']} ward {i}",
            "consent": True,
            "latitude": lat,
            "longitude": lon,
            "locationSource": "gps",
        }
        headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": idem()}
        client.post("/api/v1/check-ins", json=body, headers=headers).raise_for_status()
        print(f"  check-in {i}: {body['landmark']} ({lat}, {lon}) status={status}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--api-base", default="http://127.0.0.1:8000")
    parser.add_argument("--city", default="bengaluru", choices=sorted(CITIES))
    parser.add_argument("--volunteers", type=int, default=6)
    parser.add_argument("--citizens", type=int, default=3)
    parser.add_argument("--checkins", type=int, default=5, help="Number of citizen check-ins to seed (mix of need_help/at_risk/safe)")
    parser.add_argument("--radius-km", type=float, default=2.0)
    parser.add_argument("--staff-phone", help="Staff account used to verify/activate volunteers (see create-staff.py)")
    parser.add_argument("--staff-password", help="Prompted if omitted and --staff-phone is given")
    args = parser.parse_args()

    city = CITIES[args.city]
    staff_token = None
    try:
        with httpx.Client(base_url=args.api_base, timeout=10.0) as client:
            if args.staff_phone:
                password = args.staff_password or getpass.getpass("Staff password: ")
                if not password:
                    sys.exit("No password entered, aborting.")
                response = client.post("/api/v1/auth/login", json={"role": "staff", "phone": args.staff_phone, "password": password})
                response.raise_for_status()
                staff_token = response.json()["access_token"]
            else:
                print("No --staff-phone given: volunteers will be created but left 'pending' (verify them manually in Command Center).")

            print(f"Seeding {args.volunteers} volunteers near {city['name']}...")
            seed_volunteers(client, count=args.volunteers, city=city, radius_km=args.radius_km, staff_token=staff_token)

            print(f"Seeding {args.citizens} citizen incident reports near {city['name']}...")
            seed_citizen_reports(client, count=args.citizens, city=city, radius_km=args.radius_km)

            if args.checkins:
                print(f"Seeding {args.checkins} citizen check-ins near {city['name']}...")
                seed_checkins(client, count=args.checkins, city=city, radius_km=args.radius_km)
    except httpx.HTTPStatusError as error:
        try:
            detail = error.response.json().get("detail", error.response.text)
        except ValueError:
            detail = error.response.text
        sys.exit(f"Request to {error.request.url} failed ({error.response.status_code}): {detail}")

    print(f"\nDone. In Command Center: pick {city['name']}, then Scan -> Analyse -> Analyse (dispatch) to see Agent 3 notify the demo volunteers.")


if __name__ == "__main__":
    main()
