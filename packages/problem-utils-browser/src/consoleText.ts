import type { ConsoleMessage, JSHandle } from 'puppeteer';

type RemoteValue = ReturnType<JSHandle['remoteObject']>;

/** Formats Chromium console previews as the text expected by JavaScript course output files. */
export function consoleText(message: ConsoleMessage): string {
  const args = message.args();
  return args.length === 0 ? message.text() : args.map((argument) => previewText(argument.remoteObject())).join(' ');
}

function previewText(value: RemoteValue): string {
  if (value.type === 'undefined') return 'undefined';
  if ('value' in value) return String(value.value);
  if (value.unserializableValue) return value.unserializableValue;
  if (value.subtype === 'node') return 'JSHandle@node';
  if (value.description === 'Object' && value.preview)
    return `{${value.preview.properties.map((property) => `${property.name}: ${String(property.value)}`).join(', ')}}`;
  if (value.subtype !== 'array' || !value.preview) return value.description ?? '';

  const entries = value.preview.properties
    .map((property) => ({ index: Number(property.name), value: property.value }))
    .filter((property) => !Number.isNaN(property.index) && property.index >= 0)
    .toSorted((left, right) => left.index - right.index);
  const values: string[] = [];
  let nextIndex = 0;
  for (const entry of entries) {
    const missing = entry.index - nextIndex;
    if (missing > 0) values.push(missing === 1 ? 'empty' : `empty x ${missing}`);
    values.push(String(entry.value));
    nextIndex = entry.index + 1;
  }
  return `[${values.join(', ')}]`;
}
