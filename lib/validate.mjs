// Minimal JSON Schema validator: only the keywords ledger/schema.json uses
// (type, enum, required, properties, additionalProperties, items, pattern,
// minLength, minimum, maximum, local $ref). Any other keyword in a schema
// node throws, so a schema edit can never be silently ignored.
const KNOWN = new Set([
  "$schema", "$defs", "title", "type", "enum", "required", "properties",
  "additionalProperties", "items", "pattern", "minLength", "minimum",
  "maximum", "$ref",
]);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split("/").reduce((n, k) => n?.[k], root);
}

export function validate(value, schema, root = schema, path = "$") {
  const errs = [];
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) throw new Error(`unsupported schema keyword: ${k}`);
  }
  if (schema.$ref) return validate(value, resolve(root, schema.$ref), root, path);
  const t = typeOf(value);
  if (schema.type) {
    const ok = schema.type === t || (schema.type === "number" && t === "integer");
    if (!ok) return [`${path}: expected ${schema.type}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${path}: ${JSON.stringify(value)} not in [${schema.enum.join(", ")}]`);
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${path}: empty or too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (t === "object") {
    for (const r of schema.required ?? []) {
      if (!(r in value)) errs.push(`${path}: missing required "${r}"`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errs.push(...validate(v, props[k], root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unknown field "${k}"`);
    }
  }
  if (t === "array" && schema.items) {
    value.forEach((v, i) => errs.push(...validate(v, schema.items, root, `${path}[${i}]`)));
  }
  return errs;
}
