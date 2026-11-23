import { test, expect } from '@playwright/test';
import type { ViewNode } from '@mobilewright/protocol';
import { nativeXPathLocators, playwrightLocatorSuggestions } from './locator-suggestions.js';

function node(overrides: Partial<ViewNode> = {}): ViewNode {
  return {
    type: 'android.widget.TextView',
    isVisible: true,
    isEnabled: true,
    bounds: { x: 0, y: 0, width: 100, height: 30 },
    children: [],
    ...overrides,
  };
}

test('native XPath suggestions cover raw and normalized attributes with safe literals', () => {
  const doubleQuote = String.fromCharCode(34);
  const apostrophe = String.fromCharCode(39);
  const suggestions = nativeXPathLocators(node({
    identifier: 'product-name',
    text: String.raw`Men's "Classic" Tee`,
    raw: { 'content-desc': 'Product image', clickable: true },
  }));

  expect(suggestions).toEqual(expect.arrayContaining([
    { strategy: 'identifier', locator: String.raw`//*[@identifier='product-name']` },
    { strategy: 'text', locator: `//*[@text=concat('Men',${doubleQuote}${apostrophe}${doubleQuote},'s ${doubleQuote}Classic${doubleQuote} Tee')]` },
    { strategy: 'content-desc', locator: String.raw`//*[@content-desc='Product image']` },
    { strategy: 'clickable', locator: String.raw`//*[@clickable='true']` },
    { strategy: 'class', locator: String.raw`//*[@class='android.widget.TextView']` },
  ]));
});

test('Playwright suggestions include the unique nth position when needed', () => {
  const doubleQuote = String.fromCharCode(34);
  expect(playwrightLocatorSuggestions([
    { kind: 'text', value: 'Buy now' },
    { kind: 'role', value: 'button', name: 'Buy now' },
  ], { index: 1, count: 2 })).toEqual([
    { strategy: 'text', locator: `getByText(${doubleQuote}Buy now${doubleQuote}).nth(1)` },
    { strategy: 'role', locator: `getByRole(${doubleQuote}button${doubleQuote}, { name: ${doubleQuote}Buy now${doubleQuote} })` },
  ]);
});
