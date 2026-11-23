import type { ViewNode } from '@mobilewright/protocol';
import type { Locator, MatchPosition } from './locator-derivation.js';

export interface LocatorSuggestion {
  strategy: string;
  locator: string;
}

function xpathLiteral(value: string): string {
  const apostrophe = String.fromCharCode(39);
  const doubleQuote = String.fromCharCode(34);
  if (!value.includes(apostrophe)) return `${apostrophe}${value}${apostrophe}`;
  if (!value.includes(doubleQuote)) return `${doubleQuote}${value}${doubleQuote}`;
  const parts = value.split(apostrophe).map(part => `${apostrophe}${part}${apostrophe}`);
  return `concat(${parts.join(`,${doubleQuote}${apostrophe}${doubleQuote},`)})`;
}

export function nativeXPathLocators(node: ViewNode): LocatorSuggestion[] {
  const attributes: Record<string, unknown> = {
    ...(node.raw ?? {}),
    type: node.type,
    label: node.label,
    identifier: node.identifier,
    key: node.key,
    resourceId: node.resourceId,
    text: node.text,
    placeholder: node.placeholder,
    value: node.value,
  };
  const aliases: Record<string, string> = {
    resourceId: 'resource-id',
    contentDescription: 'content-desc',
    className: 'class',
  };
  aliases.type = node.type.startsWith('android.') ? 'class' : 'type';
  const suggestions: LocatorSuggestion[] = [];
  const seen = new Set<string>();

  for (const [name, rawValue] of Object.entries(attributes)) {
    if (!/^[A-Za-z_][\w.-]*$/.test(name) || rawValue == null || typeof rawValue === 'object') continue;
    const value = String(rawValue);
    if (!value) continue;
    const attribute = aliases[name] ?? name;
    const locator = `//*[@${attribute}=${xpathLiteral(value)}]`;
    if (seen.has(locator)) continue;
    seen.add(locator);
    suggestions.push({ strategy: attribute, locator });
  }
  return suggestions;
}

function quoteCode(value: string): string {
  return JSON.stringify(value);
}

function playwrightLocatorCode(locator: Locator): string {
  if (locator.kind === 'testId') return `getByTestId(${quoteCode(locator.value)})`;
  if (locator.kind === 'role') {
    return locator.name
      ? `getByRole(${quoteCode(locator.value)}, { name: ${quoteCode(locator.name)} })`
      : `getByRole(${quoteCode(locator.value)})`;
  }
  if (locator.kind === 'label') return `getByLabel(${quoteCode(locator.value)})`;
  return `getByText(${quoteCode(locator.value)})`;
}

export function playwrightLocatorSuggestions(
  locators: Locator[],
  match: MatchPosition | null,
): LocatorSuggestion[] {
  return locators.map((locator, index) => ({
    strategy: locator.kind,
    locator: `${playwrightLocatorCode(locator)}${index === 0 && match && match.count > 1 ? `.nth(${match.index})` : ''}`,
  }));
}
