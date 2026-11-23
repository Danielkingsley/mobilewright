import type { Device } from '@mobilewright/core';
import type { Bounds, ScreenSize, WebViewInfo, WebViewSession } from '@mobilewright/protocol';

export interface WebViewElement {
  index: number;
  depth: number;
  type: string;
  label: string | null;
  text: string | null;
  bounds: Bounds;
  isVisible: boolean;
  isEnabled: boolean;
  isSelected: boolean | null;
  isFocused: boolean | null;
  isChecked: boolean | null;
  isEditable: boolean;
  raw: Record<string, unknown>;
  locator: { kind: 'xpath'; value: string; strategy: string } | null;
  locators: Array<{ kind: 'xpath'; value: string; strategy: string }>;
  match: null;
}

export interface WebViewInspection {
  webView: WebViewInfo;
  elements: WebViewElement[];
}

const EXTRACT_WEBVIEW_ELEMENTS = String.raw`(nativeBounds, screen) => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (!viewport.width || !viewport.height) return [];
  const literal = value => {
    if (!value.includes("'")) return "'" + value + "'";
    if (!value.includes('"')) return '"' + value + '"';
    const parts = value.split("'").flatMap((part, index) => index ? ['"\'"', "'" + part + "'"] : ["'" + part + "'"]);
    return 'concat(' + parts.join(',') + ')';
  };
  const codeString = value => JSON.stringify(value);
  const toBounds = rect => {
    const frame = nativeBounds || { x: 0, y: 0, width: screen.width, height: screen.height };
    const scaleX = frame.width / viewport.width;
    const scaleY = frame.height / viewport.height;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewport.width, rect.right);
    const bottom = Math.min(viewport.height, rect.bottom);
    return {
      x: frame.x + left * scaleX,
      y: frame.y + top * scaleY,
      width: Math.max(0, right - left) * scaleX,
      height: Math.max(0, bottom - top) * scaleY,
    };
  };
  const pathFor = element => {
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const id = current.getAttribute('id');
      if (id) return '//*[@id=' + literal(id) + ']';
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(child => child.tagName === current.tagName);
        if (sameTag.length > 1) part += '[' + (sameTag.indexOf(current) + 1) + ']';
      }
      parts.unshift(part);
      current = parent;
    }
    return '/' + parts.join('/');
  };
  const nodes = Array.from(document.querySelectorAll('body *'));
  return nodes.flatMap((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
      && rect.left < viewport.width && rect.top < viewport.height;
    if (!visible) return [];
    const attributes = Object.fromEntries(Array.from(element.attributes, attribute => [attribute.name, attribute.value]));
    const tag = element.tagName.toLowerCase();
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const locators = [];
    const playwrightLocators = [];
    const addXPath = (strategy, value, expression) => {
      if (value) locators.push({ kind: 'xpath', strategy, value: expression(value) });
    };
    const addPlaywright = (strategy, locator) => {
      if (locator) playwrightLocators.push({ strategy, locator });
    };
    const cssAttributeLocator = (name, value) =>
      'locator(' + codeString('[' + name + '=' + codeString(value) + ']') + ')';
    addXPath('id', element.getAttribute('id'), value => '//*[@id=' + literal(value) + ']');
    addXPath('testId', element.getAttribute('data-testid'), value => '//*[@data-testid=' + literal(value) + ']');
    addXPath('aria-label', element.getAttribute('aria-label'), value => '//*[@aria-label=' + literal(value) + ']');
    addXPath('name', element.getAttribute('name'), value => '//' + tag + '[@name=' + literal(value) + ']');
    addXPath('placeholder', element.getAttribute('placeholder'), value => '//' + tag + '[@placeholder=' + literal(value) + ']');
    addXPath('title', element.getAttribute('title'), value => '//' + tag + '[@title=' + literal(value) + ']');
    addXPath('text', text, value => '//' + tag + '[normalize-space(.)=' + literal(value) + ']');
    const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : '';
    addXPath('class', className, value => '//' + tag + '[contains(concat(" ", normalize-space(@class), " "), ' + literal(' ' + value + ' ') + ')]');
    locators.push({ kind: 'xpath', strategy: 'absolute', value: pathFor(element) });
    const id = element.getAttribute('id');
    const testId = element.getAttribute('data-testid');
    const ariaLabel = element.getAttribute('aria-label');
    const name = element.getAttribute('name');
    const placeholder = element.getAttribute('placeholder');
    const title = element.getAttribute('title');
    if (id) addPlaywright('id', cssAttributeLocator('id', id));
    if (testId) addPlaywright('testId', 'getByTestId(' + codeString(testId) + ')');
    if (ariaLabel) addPlaywright('label', 'getByLabel(' + codeString(ariaLabel) + ')');
    if (name) addPlaywright('name', cssAttributeLocator('name', name));
    if (placeholder) addPlaywright('placeholder', 'getByPlaceholder(' + codeString(placeholder) + ')');
    if (title) addPlaywright('title', 'getByTitle(' + codeString(title) + ')');
    if (className) addPlaywright('class', cssAttributeLocator('class~', className));
    if (text) addPlaywright('text', 'getByText(' + codeString(text) + ')');
    const role = element.getAttribute('role');
    if (role && ariaLabel) {
      addPlaywright('role', 'getByRole(' + codeString(role) + ', { name: ' + codeString(ariaLabel) + ' })');
    }
    let depth = 0;
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) depth++;
    const bounds = toBounds(rect);
    if (!bounds.width || !bounds.height) return [];
    return [{
      index, depth, type: tag,
      label: element.getAttribute('aria-label') || element.getAttribute('alt') || null,
      text: text || null, bounds, isVisible: true,
      isEnabled: !('disabled' in element && element.disabled),
      isSelected: 'selected' in element ? Boolean(element.selected) : null,
      isFocused: document.activeElement === element,
      isChecked: 'checked' in element ? Boolean(element.checked) : null,
      isEditable: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.hasAttribute('contenteditable'),
      raw: {
        ...attributes,
        xpathLocators: locators.map(({ strategy, value }) => ({ strategy, locator: value })),
        playwrightLocators,
      },
      locator: locators[0] || null, locators, match: null,
    }];
  });
}`;

const EVALUATE_XPATH_LOCATOR = String.raw`(xpath, nativeBounds, screen) => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (!viewport.width || !viewport.height) return [];
  const toBounds = rect => {
    const frame = nativeBounds || { x: 0, y: 0, width: screen.width, height: screen.height };
    const scaleX = frame.width / viewport.width;
    const scaleY = frame.height / viewport.height;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewport.width, rect.right);
    const bottom = Math.min(viewport.height, rect.bottom);
    return {
      x: frame.x + left * scaleX, y: frame.y + top * scaleY,
      width: Math.max(0, right - left) * scaleX, height: Math.max(0, bottom - top) * scaleY,
    };
  };
  let result;
  try {
    result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  } catch (error) {
    throw new Error('Invalid XPath locator: ' + (error && error.message ? error.message : String(error)));
  }
  const bounds = [];
  for (let index = 0; index < result.snapshotLength; index++) {
    const node = result.snapshotItem(index);
    if (!(node instanceof Element)) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const mapped = toBounds(node.getBoundingClientRect());
    if (mapped.width && mapped.height) bounds.push(mapped);
  }
  return bounds;
}`;

async function withWebView<T>(
  device: Device,
  webViewId: string,
  run: (session: WebViewSession, webView: WebViewInfo) => Promise<T>,
): Promise<T> {
  const bridge = device.driver.webViewBridge;
  if (!bridge) throw new Error('The active device driver does not support webviews');
  const webView = (await bridge.listWebViews()).find(candidate => candidate.id === webViewId);
  if (!webView) throw new Error(`Webview "${webViewId}" was not found`);
  const session = await bridge.attachWebView(webView.id);
  try {
    return await run(session, webView);
  } finally {
    await session.close();
  }
}

export function listWebViews(device: Device): Promise<WebViewInfo[]> {
  const bridge = device.driver?.webViewBridge;
  return bridge ? bridge.listWebViews() : Promise.resolve([]);
}

export function inspectWebView(device: Device, webViewId: string, screen: ScreenSize): Promise<WebViewInspection> {
  return withWebView(device, webViewId, async (session, webView) => {
    const expression = `(${EXTRACT_WEBVIEW_ELEMENTS})(${JSON.stringify(webView.nativeBounds)},${JSON.stringify(screen)})`;
    return { webView: { ...webView, url: await session.url(), title: await session.title() }, elements: await session.evaluate<WebViewElement[]>(expression) };
  });
}

export function locateWebViewXPath(device: Device, webViewId: string, xpath: string, screen: ScreenSize): Promise<Bounds[]> {
  return withWebView(device, webViewId, (session, webView) => {
    const expression = `(${EVALUATE_XPATH_LOCATOR})(${JSON.stringify(xpath)},${JSON.stringify(webView.nativeBounds)},${JSON.stringify(screen)})`;
    return session.evaluate<Bounds[]>(expression);
  });
}
