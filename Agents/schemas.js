'use strict';

const { clampText } = require('./util');

class SchemaError extends Error {}

const RISK_LEVELS = ['low', 'moderate', 'high'];
const LANGUAGES = ['en', 'hi', 'ta', 'ml', 'kn', 'other'];
const URGENCY = ['low', 'medium', 'high', 'critical'];
const A1_ACTIONS = ['route_to_verifier', 'needs_more_info', 'no_concern'];

function asObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SchemaError('The answer must be a JSON object.');
  return raw;
}

function requiredText(raw, key, max) {
  const value = clampText(raw[key], max);
  if (!value) throw new SchemaError(`"${key}" must be a non-empty string.`);
  return value;
}

function oneOf(raw, key, allowed) {
  if (!allowed.includes(raw[key])) throw new SchemaError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  return raw[key];
}

function textList(raw, key, maxItems, maxLength) {
  const value = raw[key] ?? [];
  if (!Array.isArray(value)) throw new SchemaError(`"${key}" must be an array.`);
  return value.slice(0, maxItems).map((item) => clampText(item, maxLength)).filter(Boolean);
}

// Each validator copies only known fields, so a model cannot smuggle extra instructions such as "approve" through.
function validateA1Analysis(raw) {
  asObject(raw);
  return {
    summaryEnglish: requiredText(raw, 'summaryEnglish', 400),
    language: oneOf(raw, 'language', LANGUAGES),
    urgency: oneOf(raw, 'urgency', URGENCY),
    recommendedAction: oneOf(raw, 'recommendedAction', A1_ACTIONS),
    credibilityConcerns: textList(raw, 'credibilityConcerns', 5, 160),
  };
}

function validateEvidenceSummary(raw) {
  asObject(raw);
  return { summaryEnglish: requiredText(raw, 'summaryEnglish', 500) };
}

function validateA2Assessment(raw) {
  asObject(raw);
  if (typeof raw.agreesWithSiteRisk !== 'boolean') throw new SchemaError('"agreesWithSiteRisk" must be true or false.');
  return {
    explanationEnglish: requiredText(raw, 'explanationEnglish', 400),
    agreesWithSiteRisk: raw.agreesWithSiteRisk,
    caveats: textList(raw, 'caveats', 4, 160),
  };
}

function validateA3Rationale(raw) {
  asObject(raw);
  return {
    rationaleEnglish: requiredText(raw, 'rationaleEnglish', 500),
    risks: textList(raw, 'risks', 4, 160),
  };
}

function boundedNumber(value, key, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SchemaError(`"${key}" must be a number from ${min} to ${max}.`);
  }
  return value;
}

const PLACE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .,'()/&-]{1,119}$/u;

/** Strict check of the document embedded in the prediction web page. */
function validatePrediction(raw) {
  asObject(raw);
  if (raw.schemaVersion !== '1') throw new SchemaError('Unsupported prediction schema version.');
  if (raw.synthetic !== true) throw new SchemaError('The prediction page is not marked as synthetic test data.');
  if (typeof raw.predictionId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(raw.predictionId)) {
    throw new SchemaError('"predictionId" is missing or has an unsafe format.');
  }
  for (const key of ['issuedAt', 'validUntil']) {
    if (typeof raw[key] !== 'string' || Number.isNaN(Date.parse(raw[key]))) throw new SchemaError(`"${key}" must be a date.`);
  }
  const model = asObject(raw.model);
  const alert = asObject(raw.alert);
  if (!Array.isArray(raw.forecasts) || raw.forecasts.length < 1 || raw.forecasts.length > 20) {
    throw new SchemaError('"forecasts" must contain between 1 and 20 areas.');
  }
  const seen = new Set();
  const forecasts = raw.forecasts.map((item) => {
    asObject(item);
    const place = clampText(item.place, 120);
    if (!PLACE_PATTERN.test(place) || seen.has(place)) {
      throw new SchemaError('Each forecast needs a unique area name made of ordinary letters, digits and simple punctuation.');
    }
    seen.add(place);
    return {
      place,
      rainfallMm: boundedNumber(item.rainfallMm, 'rainfallMm', 0, 1000),
      riverLevelM: boundedNumber(item.riverLevelM, 'riverLevelM', 0, 100),
      probability: boundedNumber(item.probability, 'probability', 0, 1),
      riskLevel: oneOf(item, 'riskLevel', RISK_LEVELS),
    };
  });
  return {
    predictionId: raw.predictionId,
    issuedAt: raw.issuedAt,
    validUntil: raw.validUntil,
    modelName: clampText(model.name, 80) || 'unnamed model',
    alertLevel: oneOf(alert, 'level', RISK_LEVELS),
    headline: clampText(alert.headline, 200),
    forecasts,
  };
}

/** Return the single JSON block that the prediction page embeds for machines. */
function extractEmbeddedJson(html) {
  const matches = [...String(html).matchAll(/<script\s+id="ashraay-events"\s+type="application\/json"\s*>([\s\S]*?)<\/script>/gi)];
  if (matches.length !== 1) throw new SchemaError('Expected exactly one ashraay-events JSON block in the page.');
  try {
    return JSON.parse(matches[0][1]);
  } catch {
    throw new SchemaError('The ashraay-events block is not valid JSON.');
  }
}

/** Parse the first JSON object in a model answer, tolerating markdown fences and surrounding prose. */
function parseJsonObject(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SchemaError('The answer did not contain a JSON object.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new SchemaError('The answer was not valid JSON.');
  }
}

module.exports = {
  SchemaError, RISK_LEVELS, validateA1Analysis, validateEvidenceSummary, validateA2Assessment,
  validateA3Rationale, validatePrediction, extractEmbeddedJson, parseJsonObject,
};
