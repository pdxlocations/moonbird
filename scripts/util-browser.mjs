function inspect(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
  } catch {
    return String(value);
  }
}

export function formatWithOptions(_options, ...values) {
  if (!values.length) return "";
  if (typeof values[0] !== "string") return values.map(inspect).join(" ");
  let index = 1;
  const formatted = values[0].replace(/%([%sdifjoO])/g, (match, type) => {
    if (type === "%") return "%";
    if (index >= values.length) return match;
    const value = values[index++];
    if (type === "s") return String(value);
    if (["d", "i", "f"].includes(type)) return String(Number(value));
    return inspect(value);
  });
  return [formatted, ...values.slice(index).map(inspect)].join(" ");
}

export const types = {
  isNativeError: (value) => value instanceof Error,
};
