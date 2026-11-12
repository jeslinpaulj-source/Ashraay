"""GitHub Copilot SDK integration for the Hazard Prediction & Volunteer Dispatch agents.

Agent 1 (hazard scan), Agent 2 (hazard analyse) and Agent 3 (volunteer dispatch) can each
optionally hand their deterministic, rule-based judgement to a GitHub Copilot model for a
second opinion: Agent 1/2 can catch compound risk (e.g. continuous rain near an already-full
reservoir) that simple thresholds miss, and Agent 3 can factor in skill/language fit alongside
raw distance when choosing which nearby volunteers to ask first. This module is only exercised
when an admin turns on "copilot-sdk" mode and supplies a GitHub token tied to an account with an
active Copilot subscription (see the "Agent language model" card in the admin console).

Design:
- The model is admin-selectable: the admin console lists every model the configured token's
  Copilot account can access (`list_models`) and the chosen model id is stored alongside the
  token/mode in `AgentLlmSettings`. Nothing is hardcoded, since accounts differ in which models
  they can access.
- The SDK session runs with every tool disabled (`available_tools=[]`): the model only ever
  reasons over the JSON we send it and must answer with JSON matching our schema. It can never
  read/write files, run shell commands, or otherwise touch the host.
- Failures are surfaced, never swallowed: if copilot-sdk mode is on and the call fails (bad
  token, model unavailable, timeout, malformed response), callers get a clear error instead of
  a silent fallback to rules-only behaviour, so an operator knows the AI judgement did not run.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from typing import Any, Literal

from copilot import CopilotClient
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

HazardSeverity = Literal["low", "medium", "high"]


class CopilotJudgementError(Exception):
    """Raised whenever copilot-sdk mode is enabled but the Copilot call could not be completed."""


class RecommendedAction(BaseModel):
    """One concrete action for the Hazard Response Agent to carry out if a human approves this alert."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(max_length=120, description="Short action title, e.g. 'Evacuate low-lying wards'.")
    detail: str = Field(
        max_length=80,
        description="Short right-aligned meta text giving scale/timing, e.g. '~2,300 people (est.)' or 'Before Wed 22:00'.",
    )


class HazardScanJudgement(BaseModel):
    """Agent 1's structured response: does the compound weather/dam picture warrant an alert?"""

    model_config = ConfigDict(extra="forbid")

    severity: Literal["none", "low", "medium", "high"] = Field(
        description=(
            "Overall hazard severity for this place given every signal provided, including "
            "compound effects a simple threshold rule would miss (e.g. moderate rain on top of "
            "an already-full reservoir). Use 'none' only if you are confident there is no "
            "meaningful flood/landslide risk right now."
        )
    )
    reasons: list[str] = Field(
        min_length=1,
        max_length=6,
        description=(
            "Short, plain-language reasons a duty officer can read at a glance, each citing the "
            "specific numbers (rain mm, reservoir %, flood/landslide risk %) that justify it."
        ),
    )
    confidence: float = Field(
        ge=0,
        le=1,
        description="Your confidence in this severity judgement, from 0 (pure guess) to 1 (near certain).",
    )
    flood_window_hours: str = Field(
        max_length=20,
        description=(
            "Estimated hour range until hazard impact if severity is not 'none', e.g. '36-48'. "
            "Empty string if severity is 'none' or timing cannot be estimated."
        ),
    )
    recommended_actions: list[RecommendedAction] = Field(
        max_length=6,
        description=(
            "Concrete actions for the Hazard Response Agent to take if a human approves this alert "
            "(e.g. evacuate specific wards, alert the dam authority, prepare relief shelters). "
            "Empty if severity is 'none'."
        ),
    )


class HazardAnalyseJudgement(BaseModel):
    """Agent 2's structured response: final severity and volunteer headcount after consolidation."""

    model_config = ConfigDict(extra="forbid")

    severity: HazardSeverity = Field(description="Final severity after weighing the consolidated incident/check-in data.")
    volunteers_needed: int = Field(
        ge=1,
        le=100,
        description="How many volunteers the response agent should try to dispatch for this hazard, first round.",
    )
    reasons: list[str] = Field(
        min_length=1,
        max_length=6,
        description="Short, plain-language reasons citing the consolidated numbers that justify the call.",
    )


class DispatchSelection(BaseModel):
    """Agent 3's structured response: which candidate volunteers to dispatch first this round, and why."""

    model_config = ConfigDict(extra="forbid")

    selected_ids: list[str] = Field(
        min_length=1,
        max_length=100,
        description=(
            "Candidate volunteer ids to ask this round, most important first. Must only use ids from "
            "the given candidate list - never invent an id."
        ),
    )
    reasons: list[str] = Field(
        min_length=1,
        max_length=6,
        description="Short, plain-language reasons for this pick order (distance and/or skill/language fit).",
    )


_client: CopilotClient | None = None
_client_token: str | None = None
_client_lock = asyncio.Lock()


async def _get_client(token: str) -> CopilotClient:
    """Returns a running CopilotClient for this token, (re)starting it if the token changed."""
    global _client, _client_token
    async with _client_lock:
        if _client is not None and _client_token == token:
            return _client
        if _client is not None:
            try:
                await _client.stop()
            except Exception:
                logger.exception("Failed to stop the previous Copilot SDK client cleanly; continuing.")
            _client = None
        client = CopilotClient(github_token=token, use_logged_in_user=False)
        try:
            await client.start()
        except Exception as exc:
            raise CopilotJudgementError(
                "Could not start the GitHub Copilot SDK runtime. Check that the configured token is a "
                "gho_/ghu_/github_pat_ token (not a classic ghp_ token) for an account with an active "
                f"Copilot subscription. Details: {exc}"
            ) from exc
        _client = client
        _client_token = token
        return client


async def _ensure_model_available(client: CopilotClient, model: str) -> None:
    try:
        models = await client.list_models()
    except Exception as exc:
        raise CopilotJudgementError(f"Could not list available Copilot models: {exc}") from exc
    available_ids = sorted(m.id for m in models)
    if model not in available_ids:
        raise CopilotJudgementError(
            f"The configured model '{model}' is not available to this Copilot account. "
            f"Available models: {', '.join(available_ids) if available_ids else '(none)'}."
        )


async def list_models(token: str) -> list[dict[str, Any]]:
    """Returns every model this token's Copilot account can access, for the admin console's model picker."""
    client = await _get_client(token)
    try:
        models = await client.list_models()
    except Exception as exc:
        raise CopilotJudgementError(f"Could not list available Copilot models: {exc}") from exc
    return [
        {
            "id": m.id,
            "name": m.name,
            "enabled": (m.policy.state == "enabled") if m.policy else True,
        }
        for m in sorted(models, key=lambda m: m.id)
    ]


async def _ask(token: str, model: str, prompt: str, response_type: type[BaseModel], *, timeout: float = 25.0) -> BaseModel:
    client = await _get_client(token)
    await _ensure_model_available(client, model)
    session = await client.create_session(
        model=model,
        available_tools=[],  # No file/shell/MCP tool access: pure text-in, JSON-out reasoning.
        working_directory=tempfile.gettempdir(),
    )
    try:
        return await session.send_and_wait_typed(prompt, response_type, timeout=timeout)
    except Exception as exc:
        raise CopilotJudgementError(f"Copilot hazard judgement call failed: {exc}") from exc
    finally:
        try:
            await session.disconnect()
        except Exception:
            logger.exception("Failed to disconnect the Copilot SDK session cleanly; continuing.")


async def judge_hazard_scan(
    *,
    place: str,
    rain_mm: float,
    rain_window_hours: int,
    flood_risk_pct: float,
    landslide_risk_pct: float,
    reservoir_fill_pct: float,
    rule_severity: HazardSeverity | None,
    rule_reasons: list[str],
    token: str,
    model: str,
) -> HazardScanJudgement:
    """Agent 1: ask Copilot to judge hazard severity for a city from the weather/dam signals."""
    prompt = (
        "You are a disaster-response hazard analyst reviewing simulator forecasts and dam data for one source, "
        "looking for flood/landslide risk, including compound risks (e.g. continuous rain combined with "
        "an already-near-full reservoir can cause flooding even when no single number looks extreme).\n\n"
        f"Place: {place}\n"
        f"Peak rainfall forecast (next {rain_window_hours}h): {rain_mm} mm\n"
        f"72-hour flood risk index: {flood_risk_pct}%\n"
        f"Landslide risk index: {landslide_risk_pct}%\n"
        f"Reservoir/dam fill level: {reservoir_fill_pct}%\n\n"
        "For reference, a simple threshold rule alone computed "
        f"severity={rule_severity or 'none'} with reasons: {rule_reasons or ['(no alert)']}.\n"
        "Give your own final judgement; you may raise or lower this if the full picture warrants it. "
        "If severity is not 'none', also estimate your confidence, the hour range until impact "
        "(flood_window_hours, e.g. '36-48'), and list concrete recommended_actions for the Hazard "
        "Response Agent to take once a human approves this alert (e.g. evacuate specific low-lying "
        "areas with an estimated headcount, alert the dam/reservoir authority with a deadline, "
        "prepare relief shelters with a shelter/bed estimate). Respond with the requested JSON only."
    )
    result = await _ask(token, model, prompt, HazardScanJudgement)
    assert isinstance(result, HazardScanJudgement)
    return result


async def judge_hazard_analyse(
    *,
    place: str,
    scope: str,
    severity: HazardSeverity,
    total_incidents: int,
    approved_incidents: int,
    pending_review_incidents: int,
    people_reported: int,
    checkins_need_help: int,
    checkins_at_risk: int,
    checkins_safe: int,
    rule_volunteers_needed: int,
    token: str,
    model: str,
) -> HazardAnalyseJudgement:
    """Agent 2: ask Copilot to confirm/adjust severity and volunteer headcount from consolidated data."""
    prompt = (
        "You are a disaster-response coordinator deciding how many volunteers to dispatch for a hazard "
        "alert, after consolidating incident reports and citizen check-ins near the hazard.\n\n"
        f"Place: {place}\n"
        f"Consolidation scope: {scope} (area-level reports used if available, else city-wide)\n"
        f"Hazard severity so far: {severity}\n"
        f"Incident reports: {total_incidents} total, {approved_incidents} approved/verified, "
        f"{pending_review_incidents} still pending review\n"
        f"People reported affected: {people_reported}\n"
        f"Citizen check-ins: {checkins_need_help} need help, {checkins_at_risk} at risk, {checkins_safe} safe\n\n"
        f"A simple lookup table alone would dispatch {rule_volunteers_needed} volunteers for this severity.\n"
        "Give your own final severity and volunteer headcount for the first dispatch round; adjust either "
        "if the consolidated data warrants it. Respond with the requested JSON only."
    )
    result = await _ask(token, model, prompt, HazardAnalyseJudgement)
    assert isinstance(result, HazardAnalyseJudgement)
    return result


async def judge_dispatch_selection(
    *,
    place: str,
    severity: HazardSeverity,
    still_needed: int,
    candidates: list[dict[str, Any]],
    token: str,
    model: str,
) -> DispatchSelection:
    """Agent 3: ask Copilot which nearby verified volunteers to ask first for a hazard.

    `candidates` is a pre-filtered, nearest-first pool of verified/available volunteers; Copilot may
    only choose ids from that pool, never invent new ones."""
    candidate_lines = "\n".join(
        f"- id={item['id']} name={item['displayName']} distanceKm={item['_distanceKm']:.1f} "
        f"skills={','.join(item.get('skills') or [])} languages={','.join(item.get('languages') or [])}"
        for item in candidates
    )
    prompt = (
        "You are a disaster-response dispatcher choosing which verified, available volunteers to ask "
        "first for a hazard, from a candidate pool already filtered to those near the hazard. Distance "
        "is the default priority, but prefer volunteers whose skills/languages best fit the hazard when "
        "the choice is close, instead of blindly picking the nearest.\n\n"
        f"Place: {place}\n"
        f"Hazard severity: {severity}\n"
        f"Volunteers still needed this round: {still_needed}\n"
        f"Candidates (nearest first):\n{candidate_lines}\n\n"
        f"Pick up to {still_needed} candidate id(s) to ask in this round, most important first. "
        "Only use ids from the candidate list above. Respond with the requested JSON only."
    )
    result = await _ask(token, model, prompt, DispatchSelection)
    assert isinstance(result, DispatchSelection)
    return result


async def shutdown() -> None:
    """Stops the cached Copilot SDK client, if one was started. Call this on app shutdown."""
    global _client, _client_token
    async with _client_lock:
        if _client is not None:
            try:
                await _client.stop()
            except Exception:
                logger.exception("Failed to stop the Copilot SDK client during shutdown.")
            _client = None
            _client_token = None
