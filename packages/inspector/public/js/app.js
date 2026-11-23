// Shared Mobilewright Inspector frontend, used by inspect.js and codegen.js. No framework, no build step.

// ---- Pure locator utilities ----

const DEFAULT_HIDDEN_TESTIDS = new Set(['android:id/content'])

function locatorKey(locator) {
  if (locator.kind === 'role') return `role:${locator.value}:${locator.name ?? ''}`
  return `${locator.kind}:${locator.value}`
}

export function escQ(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function locatorLabel(locator) {
  if (locator.kind === 'playwright') return locator.value
  if (locator.kind === 'xpath') return locator.value
  if (locator.kind === 'testId') return `getByTestId('${escQ(locator.value)}')`
  if (locator.kind === 'role') {
    return locator.name
      ? `getByRole('${escQ(locator.value)}', { name: '${escQ(locator.name)}' })`
      : `getByRole('${escQ(locator.value)}')`
  }
  if (locator.kind === 'label') return `getByLabel('${escQ(locator.value)}')`
  if (locator.kind === 'text') return `getByText('${escQ(locator.value)}')`
  return ''
}

// The code that selects this element: its best locator, plus .nth() when the query engine
// resolves that locator to several elements (el.match comes from the server).
export function locatorCode(el) {
  if (!el.locator) {
    return null
  }
  const base = locatorLabel(el.locator)
  if (el.match && el.match.count > 1) {
    return `${base}.nth(${el.match.index})`
  }
  return base
}

function matchesLocatorSuggestion(el, locator) {
  const raw = el.raw ?? {}
  const suggestions = [
    locatorCode(el),
    ...(el.locators ?? []).map(locatorLabel),
    ...(raw.xpathLocators ?? []).map(item => item.locator),
    ...(raw.playwrightLocators ?? []).map(item => item.locator),
  ]
  return suggestions.includes(locator)
}

function nativeXPathBounds(elements, xpath) {
  const xml = document.implementation.createDocument(null, 'hierarchy')
  const nodes = new Map()
  const parents = [xml.documentElement]

  for (const element of elements) {
    const depth = Math.max(0, element.depth ?? 0)
    parents.length = depth + 1
    const parent = parents[depth] ?? xml.documentElement
    const tag = /^[A-Za-z_][\w.-]*$/.test(element.type ?? '') ? element.type : 'element'
    const node = xml.createElement(tag)
    const attributes = {
      ...(element.raw ?? {}),
      type: element.type,
      text: element.text,
      label: element.label,
      identifier: element.identifier,
      resourceId: element.resourceId,
      placeholder: element.placeholder,
      value: element.value,
    }

    for (const [name, value] of Object.entries(attributes)) {
      if (!/^[A-Za-z_][\w.-]*$/.test(name) || value == null || typeof value === 'object') continue
      const stringValue = String(value)
      node.setAttribute(name, stringValue)
      if (name === 'resourceId') node.setAttribute('resource-id', stringValue)
      if (name === 'contentDescription') node.setAttribute('content-desc', stringValue)
      if (name === 'type' && stringValue.startsWith('android.')) node.setAttribute('class', stringValue)
    }

    parent.appendChild(node)
    parents[depth + 1] = node
    nodes.set(node, element)
  }

  let result
  try {
    result = document.evaluate(xpath, xml, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
  } catch (error) {
    throw new Error(`Invalid XPath locator: ${error.message}`)
  }

  const bounds = []
  for (let index = 0; index < result.snapshotLength; index++) {
    const element = nodes.get(result.snapshotItem(index))
    if (element?.isVisible && element.bounds?.width > 0 && element.bounds?.height > 0) {
      bounds.push(element.bounds)
    }
  }
  return bounds
}

function buildDuplicateSet(elements) {
  const counts = new Map()
  for (const el of elements) {
    if (!el.locator) continue
    const key = locatorKey(el.locator)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const dupes = new Set()
  for (const [k, n] of counts) if (n > 1) dupes.add(k)
  return dupes
}

// ---- ScreenshotPane ----
// Owns the screenshot image, SVG highlight overlay, and placeholder state.

export class ScreenshotPane {
  #img
  #overlay
  #placeholder
  #placeholderTitle
  #placeholderSub
  #logicalWidth = 0
  #logicalHeight = 0
  #deviceScale = 0  // device pixels per logical point, e.g. 3 on most iPhones
  #elements = []
  #hiddenIndices = new Set()
  #selectedIndex = null
  #onClickCb = null
  #screenshotPane  // cached pane element for #constrainSize
  // O(1) lookup from element index to its SVG rect; rebuilt on each renderHighlights call.
  #rectByIndex = new Map()
  #locatorRects = []
  #showAllHighlights
  #hoverRect = null

  // showAllHighlights: false draws no element boxes, only the one passed to showHoverBox (codegen).
  constructor({ showAllHighlights = true } = {}) {
    this.#showAllHighlights = showAllHighlights
    this.#img = document.getElementById('screenshot-img')
    this.#overlay = document.getElementById('highlight-overlay')
    this.#placeholder = document.getElementById('no-device-msg')
    this.#placeholderTitle = document.getElementById('placeholder-title')
    this.#placeholderSub = document.getElementById('placeholder-sub')
    this.#screenshotPane = document.getElementById('screenshot-pane')
    new ResizeObserver(() => this.#constrainSize()).observe(this.#screenshotPane)
  }

  onElementClick(cb) { this.#onClickCb = cb }

  // Report clicks / pointer moves on the screenshot as integer device coordinates (logical points, not image pixels).
  // The third argument is whether Shift was held.
  onScreenTap(cb) {
    this.#img.addEventListener('click', e => cb(...this.#devicePointOf(e), e.shiftKey))
  }

  onScreenHover(cb) {
    this.#img.addEventListener('mousemove', e => cb(...this.#devicePointOf(e), e.shiftKey))
    this.#img.addEventListener('mouseleave', () => cb(null, null, false))
  }

  // The smallest visible element under (x, y) that passes `accepts`, or null.
  elementAt(x, y, accepts = () => true) {
    let best = null
    for (const el of this.#visibleElements()) {
      const b = el.bounds
      const isInside = x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
      if (isInside && accepts(el) && (!best || b.width * b.height < best.bounds.width * best.bounds.height)) {
        best = el
      }
    }
    return best
  }

  showHoverBox(el) {
    this.#hoverRect?.remove()
    this.#hoverRect = null
    if (!el) {
      return
    }
    const { x, y, width, height } = el.bounds
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    rect.setAttribute('x', x)
    rect.setAttribute('y', y)
    rect.setAttribute('width', width)
    rect.setAttribute('height', height)
    rect.classList.add('hover-rect')
    this.#hoverRect = rect
    this.#overlay.appendChild(rect)
  }

  #devicePointOf(e) {
    const box = this.#img.getBoundingClientRect()
    const scaleX = (this.#logicalWidth || this.#img.naturalWidth) / box.width
    const scaleY = (this.#logicalHeight || this.#img.naturalHeight) / box.height
    return [Math.round((e.clientX - box.left) * scaleX), Math.round((e.clientY - box.top) * scaleY)]
  }

  get isScreenshotHidden() { return this.#img.hidden }

  showPlaceholder(title, sub = '', loading = false) {
    this.#placeholder.hidden = false
    this.#img.hidden = true
    this.#overlay.setAttribute('hidden', '')
    this.#placeholderTitle.textContent = title
    this.#placeholderSub.textContent = sub
    this.#placeholder.classList.toggle('loading', loading)
  }

  showScreenshot(dataUrl, logicalWidth = 0, logicalHeight = 0, deviceScale = 0) {
    this.#logicalWidth = logicalWidth
    this.#logicalHeight = logicalHeight
    this.#deviceScale = deviceScale
    this.#placeholder.hidden = true
    this.#placeholder.classList.remove('loading')
    this.#img.hidden = false
    this.#overlay.removeAttribute('hidden')
    this.#img.src = dataUrl
    this.#img.onload = () => this.#constrainSize()
  }

  renderHighlights(elements, hiddenIndices, selectedIndex) {
    this.#elements = elements
    this.#hiddenIndices = hiddenIndices
    this.#selectedIndex = selectedIndex
    this.#buildRects()
  }

  showLocatorHighlights(bounds) {
    this.clearLocatorHighlights()
    for (const bound of bounds) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', bound.x)
      rect.setAttribute('y', bound.y)
      rect.setAttribute('width', bound.width)
      rect.setAttribute('height', bound.height)
      rect.classList.add('locator-match-rect')
      this.#locatorRects.push(rect)
      this.#overlay.appendChild(rect)
    }
  }

  clearLocatorHighlights() {
    for (const rect of this.#locatorRects) rect.remove()
    this.#locatorRects = []
  }

  setSelectedIndex(index) {
    // O(1): deselect old rect, select new one directly via index map.
    this.#rectByIndex.get(this.#selectedIndex)?.classList.remove('selected')
    this.#selectedIndex = index
    this.#rectByIndex.get(index)?.classList.add('selected')
  }

  #buildRects() {
    this.#overlay.innerHTML = ''
    this.#locatorRects = []
    this.#hoverRect = null
    this.#rectByIndex.clear()
    if (!this.#showAllHighlights) {
      return
    }
    for (const el of this.#visibleElements()) {
      const { x, y, width, height } = el.bounds
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', x)
      rect.setAttribute('y', y)
      rect.setAttribute('width', width)
      rect.setAttribute('height', height)
      rect.classList.add('highlight-rect')
      if (el.index === this.#selectedIndex) rect.classList.add('selected')
      rect.addEventListener('click', () => this.#onClickCb?.(el.index))
      rect.addEventListener('mouseenter', () => rect.classList.add('hovered'))
      rect.addEventListener('mouseleave', () => rect.classList.remove('hovered'))
      this.#rectByIndex.set(el.index, rect)
      this.#overlay.appendChild(rect)
    }
  }

  #visibleElements() {
    return this.#elements.filter(el =>
      el.bounds &&
      el.isVisible &&
      !this.#hiddenIndices.has(el.index) &&
      el.bounds.width > 0 &&
      el.bounds.height > 0
    )
  }

  // Ask for a half-size screenshot when the pane can show at most half of the device's
  // pixel height anyway; the full-size image would only be downscaled by the browser.
  preferredScreenshotScale() {
    const devicePixelHeight = this.#logicalHeight * this.#deviceScale
    if (!devicePixelHeight) {
      return 1
    }
    const panePixelHeight = this.#availableHeight() * window.devicePixelRatio
    return panePixelHeight <= devicePixelHeight / 2 ? 0.5 : 1
  }

  // Height left for the screenshot below anything stacked above it in the pane (codegen's device toolbar).
  #availableHeight() {
    const cs = getComputedStyle(this.#screenshotPane)
    const container = this.#img.parentElement
    return this.#screenshotPane.clientHeight - container.offsetTop - parseFloat(cs.paddingBottom)
  }

  #constrainSize() {
    if (this.#img.hidden) return
    this.#img.style.maxHeight = this.#availableHeight() + 'px'
    const vw = this.#logicalWidth || this.#img.naturalWidth
    const vh = this.#logicalHeight || this.#img.naturalHeight
    this.#overlay.setAttribute('width', this.#img.offsetWidth)
    this.#overlay.setAttribute('height', this.#img.offsetHeight)
    this.#overlay.setAttribute('viewBox', `0 0 ${vw} ${vh}`)
  }
}

// ---- DetailPane ----
// Shows element properties, all locator strategies, raw attributes.

export class DetailPane {
  #pane
  #typeEl
  #locatorsEl
  #propsEl
  #rawEl
  #isRawExpanded = false  // survives re-renders, so the section stays open across row clicks
  #closeBtn
  #onCloseCb = null

  constructor() {
    this.#pane = document.getElementById('detail-pane')
    this.#typeEl = document.getElementById('detail-type')
    this.#locatorsEl = document.getElementById('detail-locators')
    this.#propsEl = document.getElementById('detail-properties')
    this.#rawEl = document.getElementById('detail-raw')
    this.#closeBtn = document.getElementById('detail-close')
    this.#closeBtn.addEventListener('click', () => {
      this.hide()
      this.#onCloseCb?.()
    })
  }

  onClose(cb) { this.#onCloseCb = cb }

  show(el) {
    if (!el) { this.hide(); return }

    this.#typeEl.textContent = el.type ?? 'unknown'

    // Locators
    this.#locatorsEl.innerHTML = ''
    const locators = [...(el.locators ?? [])]
    const seenLocators = new Set(locators.map(locatorLabel))
    for (const item of el.raw?.xpathLocators ?? []) {
      if (item.locator && !seenLocators.has(item.locator)) {
        locators.push({ kind: 'xpath', strategy: item.strategy, value: item.locator })
        seenLocators.add(item.locator)
      }
    }
    if (!locators.some(locator => locator.kind !== 'xpath')) {
      for (const item of el.raw?.playwrightLocators ?? []) {
        if (item.locator && !seenLocators.has(item.locator)) {
          locators.push({ kind: 'playwright', strategy: item.strategy, value: item.locator })
          seenLocators.add(item.locator)
        }
      }
    }
    if (locators.length) {
      const label = document.createElement('div')
      label.className = 'detail-section-label'
      label.textContent = 'Locator Strategies'
      this.#locatorsEl.appendChild(label)

      for (const loc of locators) {
        const row = document.createElement('div')
        row.className = 'detail-locator-row'
        row.title = 'Click to copy'

        const badge = document.createElement('span')
        badge.className = `locator-badge badge-${loc.kind}`
        badge.textContent = loc.strategy ?? loc.kind
        if (loc.strategy) badge.title = `${loc.strategy} ${loc.kind === 'xpath' ? 'XPath' : 'locator'}`
        row.appendChild(badge)

        const val = document.createElement('span')
        val.className = 'locator-value'
        val.textContent = locatorLabel(loc)
        row.appendChild(val)

        const copyBtn = document.createElement('button')
        copyBtn.className = 'copy-btn'
        copyBtn.textContent = '📋'
        copyBtn.title = 'Copy locator'
        copyBtn.addEventListener('click', e => {
          e.stopPropagation()
          navigator.clipboard.writeText(locatorLabel(loc)).then(() => {
            copyBtn.textContent = '✓'
            copyBtn.classList.add('copied')
            setTimeout(() => { copyBtn.textContent = '📋'; copyBtn.classList.remove('copied') }, 1500)
          }).catch(() => {})
        })
        row.appendChild(copyBtn)

        row.addEventListener('click', () => {
          navigator.clipboard.writeText(locatorLabel(loc)).catch(() => {})
        })

        this.#locatorsEl.appendChild(row)
      }
    } else {
      const row = document.createElement('div')
      row.className = 'detail-locator-row'
      row.style.opacity = '0.5'
      row.textContent = '(no locator available)'
      this.#locatorsEl.appendChild(row)
    }

    // Properties
    this.#propsEl.innerHTML = ''
    const propLabel = document.createElement('div')
    propLabel.className = 'detail-section-label'
    propLabel.textContent = 'Properties'
    this.#propsEl.appendChild(propLabel)

    const props = [
      { key: 'type', value: el.type },
      { key: 'label', value: el.label },
      { key: 'text', value: el.text },
      { key: 'identifier', value: el.identifier },
      { key: 'resourceId', value: el.resourceId },
      { key: 'placeholder', value: el.placeholder },
      { key: 'value', value: el.value },
      { key: 'bounds', value: el.bounds ? `${el.bounds.x},${el.bounds.y} ${el.bounds.width}×${el.bounds.height}` : null },
      { key: 'visible', value: el.isVisible },
      { key: 'enabled', value: el.isEnabled },
      { key: 'selected', value: el.isSelected },
      { key: 'focused', value: el.isFocused },
      { key: 'checked', value: el.isChecked },
    ]

    for (const p of props) {
      if (p.value === null || p.value === undefined) continue
      const row = document.createElement('div')
      row.className = 'detail-prop-row'

      const key = document.createElement('span')
      key.className = 'detail-prop-key'
      key.textContent = p.key
      row.appendChild(key)

      const val = document.createElement('span')
      val.className = 'detail-prop-value'
      if (typeof p.value === 'boolean') {
        val.className += p.value ? ' boolean-true' : ' boolean-false'
        val.textContent = String(p.value)
      } else {
        val.textContent = String(p.value)
      }
      row.appendChild(val)

      this.#propsEl.appendChild(row)
    }

    // Raw attributes (collapsible)
    if (el.raw && typeof el.raw === 'object' && Object.keys(el.raw).length > 0) {
      this.#rawEl.hidden = false
      this.#rawEl.innerHTML = ''

      const toggle = document.createElement('button')
      toggle.className = 'detail-raw-toggle'
      this.#rawEl.appendChild(toggle)

      const content = document.createElement('div')
      content.className = 'detail-raw-content'
      content.textContent = JSON.stringify(el.raw, null, 2)

      const renderExpanded = () => {
        content.hidden = !this.#isRawExpanded
        toggle.textContent = `${this.#isRawExpanded ? '▼' : '▶'} Raw Attributes (${Object.keys(el.raw).length})`
      }
      renderExpanded()

      toggle.addEventListener('click', () => {
        this.#isRawExpanded = !this.#isRawExpanded
        renderExpanded()
      })

      this.#rawEl.appendChild(content)
    } else {
      this.#rawEl.hidden = true
    }

    this.#pane.hidden = false
  }

  hide() {
    this.#pane.hidden = true
  }
}

// ---- ElementsPane ----
// Owns the element list: rendering rows, selection state, visibility toggles.

class ElementsPane {
  #list
  #onClickCb = null
  #onToggleCb = null
  // O(1) lookup from element index to its row element; rebuilt on each render call.
  #rowByIndex = new Map()
  #selectedRow = null

  constructor() {
    this.#list = document.getElementById('elements-list')
    this.#list.setAttribute('role', 'list')
  }

  onElementClick(cb) { this.#onClickCb = cb }
  onToggleHidden(cb) { this.#onToggleCb = cb }

  render(elements, hiddenIndices) {
    this.#list.innerHTML = ''
    this.#rowByIndex.clear()
    this.#selectedRow = null
    if (elements.length === 0) {
      const msg = document.createElement('div')
      msg.className = 'pane-message'
      msg.textContent = 'No elements'
      this.#list.appendChild(msg)
      return
    }
    const dupes = buildDuplicateSet(elements)
    for (const el of elements) {
      const row = this.#buildRow(el, hiddenIndices, dupes)
      this.#rowByIndex.set(el.index, row)
      this.#list.appendChild(row)
    }
  }

  setSelectedIndex(index) {
    // O(1): deselect previous row, select new one directly via index map.
    this.#selectedRow?.classList.remove('selected')
    this.#selectedRow = this.#rowByIndex.get(index) ?? null
    if (this.#selectedRow) {
      this.#selectedRow.classList.add('selected')
      this.#selectedRow.scrollIntoView({ block: 'nearest' })
      // Focus follows selection so arrow keys work after clicking the screenshot too.
      this.#selectedRow.focus({ preventScroll: true })
    }
  }

  updateRowVisibility(index, hidden) {
    const row = this.#rowByIndex.get(index)
    if (!row) return
    row.classList.toggle('element-hidden', hidden)
    const btn = row.querySelector('.vis-btn')
    if (btn) {
      btn.textContent = hidden ? '○' : '◉'
      btn.title = hidden ? 'Show on screenshot' : 'Hide from screenshot'
      btn.setAttribute('aria-label', hidden ? 'Show on screenshot' : 'Hide from screenshot')
      btn.setAttribute('aria-pressed', String(!hidden))
    }
  }

  #buildRow(el, hiddenIndices, dupes) {
    const row = document.createElement('div')
    row.className = 'element-row'
    row.setAttribute('role', 'listitem')
    row.tabIndex = 0
    row.dataset.index = el.index
    if (!el.locator) row.classList.add('no-locator')
    if (hiddenIndices.has(el.index)) row.classList.add('element-hidden')

    const locLabel = locatorCode(el)
    row.setAttribute('aria-label', locLabel ?? `${el.type ?? 'unknown'} (no locator)`)

    const badge = document.createElement('span')
    badge.className = `locator-badge badge-${el.locator?.kind ?? 'none'}`
    badge.textContent = el.locator?.kind ?? 'none'
    row.appendChild(badge)

    const value = document.createElement('span')
    value.className = 'locator-value'
    value.textContent = locLabel ?? '(no locator)'
    if (locLabel) value.title = locLabel
    row.appendChild(value)

    if (el.locator && dupes.has(locatorKey(el.locator))) {
      const warn = document.createElement('span')
      warn.className = 'duplicate-warning'
      warn.textContent = 'dup'
      warn.title = 'Multiple elements share this locator'
      row.appendChild(warn)
    }

    if (el.locators && el.locators.length > 1) {
      const more = document.createElement('span')
      more.className = 'locator-more'
      more.textContent = `+${el.locators.length - 1} more`
      more.title = el.locators.slice(1).map(l => locatorLabel(l)).join('\n')
      row.appendChild(more)
    }

    const type = document.createElement('span')
    type.className = 'element-type'
    type.textContent = el.type ?? ''
    row.appendChild(type)

    const isHidden = hiddenIndices.has(el.index)
    const visBtn = document.createElement('button')
    visBtn.className = 'vis-btn'
    visBtn.textContent = isHidden ? '○' : '◉'
    visBtn.title = isHidden ? 'Show on screenshot' : 'Hide from screenshot'
    visBtn.setAttribute('aria-label', isHidden ? 'Show on screenshot' : 'Hide from screenshot')
    visBtn.setAttribute('aria-pressed', String(!isHidden))
    visBtn.addEventListener('click', e => { e.stopPropagation(); this.#onToggleCb?.(el.index) })
    row.appendChild(visBtn)

    row.addEventListener('click', () => this.#onClickCb?.(el.index))
    row.addEventListener('keydown', e => {
      if (e.target !== row) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.#onClickCb?.(el.index)
      }
      const neighbour = { ArrowUp: row.previousElementSibling, ArrowDown: row.nextElementSibling }[e.key]
      if (neighbour) {
        e.preventDefault()
        this.#onClickCb?.(Number(neighbour.dataset.index))
      }
    })
    return row
  }
}

// ---- Inspector ----
// Orchestrates device management, the refresh cycle, and shared selection/visibility state.

export class Inspector {
  #state = {
    devices: [],
    activeId: null,
    elements: [],
    nativeElements: [],
    webViews: [],
    webViewsLoaded: false,
    webViewDiscoveryError: null,
    webViewInspectionError: null,
    pageMode: 'native',
    activeWebViewId: null,
    selectedIndex: null,
    logicalWidth: 0,
    logicalHeight: 0,
    hiddenIndices: new Set(),
  }
  // Persists user visibility overrides across refreshes: locatorKey -> 'hidden' | 'visible'.
  // Pruned on each refresh to keys present in the new element list.
  #userOverrides = new Map()
  #autoRefreshTimer = null
  // Etag of the payload on screen. Cleared whenever the screen stops showing it, so a 304 never
  // leaves a placeholder or another device's state up.
  #shownEtag = null
  #tickInFlight = false
  #refreshInFlight = false
  #connectInFlight = false
  #consecutiveErrors = 0
  static #MAX_CONSECUTIVE_ERRORS = 3
  static #MIN_FRAME_MS = 100
  // Continuous mode has no refresh controls, so the device list is polled on its own to pick up
  // devices connected after the page opened (and disconnects between frames).
  static #DEVICE_LIST_REFRESH_MS = 5000

  #screenshotPane
  #elementsPane
  #detailPane
  #deviceSelect = document.getElementById('device-select')
  #viewModeSelect = document.getElementById('view-mode-select')
  #webViewSelect = document.getElementById('webview-select')
  #locatorCheckForm = document.getElementById('locator-check-form')
  #locatorInput = document.getElementById('locator-input')
  #locatorCheckButton = document.getElementById('locator-check-btn')
  #locatorCheckStatus = document.getElementById('locator-check-status')
  #refreshBtn = document.getElementById('refresh-btn')
  #autoRefreshToggle = document.getElementById('auto-refresh-toggle')
  #autoRefreshInterval = document.getElementById('auto-refresh-interval')
  #statusBar = document.getElementById('status-bar')

  #onActiveDeviceChangeCb
  #isContinuousRefresh

  // Panes are injectable so pages without an element list (codegen) can pass no-op stand-ins.
  // onActiveDeviceChange(device | null) fires whenever the active device may have changed; it must be idempotent.
  // continuousRefresh: request the next screenshot as soon as the previous one arrives, forever,
  // for pages without the refresh controls (codegen).
  constructor({ screenshotPane = new ScreenshotPane(), elementsPane = new ElementsPane(), detailPane = new DetailPane(), onActiveDeviceChange = null, continuousRefresh = false } = {}) {
    this.#isContinuousRefresh = continuousRefresh
    this.#screenshotPane = screenshotPane
    this.#elementsPane = elementsPane
    this.#detailPane = detailPane
    this.#onActiveDeviceChangeCb = onActiveDeviceChange
    this.#screenshotPane.onElementClick(i => this.#selectElement(i))
    this.#elementsPane.onElementClick(i => this.#selectElement(i))
    this.#elementsPane.onToggleHidden(i => this.#toggleHidden(i))
    this.#detailPane.onClose(() => { this.#state.selectedIndex = null; this.#screenshotPane.setSelectedIndex(null); this.#elementsPane.setSelectedIndex(null) })

    this.#refreshBtn?.addEventListener('click', () => this.refresh(true))
    this.#deviceSelect.addEventListener('change', () => {
      const opt = this.#deviceSelect.selectedOptions[0]
      if (!opt?.value) return
      const device = this.#state.devices.find(d => d.id === opt.value)
      if (device) this.#connectDevice(device)
    })
    this.#autoRefreshToggle?.addEventListener('change', () => this.#applyAutoRefresh())
    this.#autoRefreshInterval?.addEventListener('change', () => this.#applyAutoRefresh())
    this.#viewModeSelect?.addEventListener('change', () => {
      this.#state.pageMode = this.#viewModeSelect.value
      this.#shownEtag = null
      this.#syncPagePicker()
      if (this.#state.pageMode === 'webview') {
        this.#renderElements([])
      } else {
        this.#renderElements(this.#state.nativeElements)
      }
      this.refresh()
    })
    this.#webViewSelect?.addEventListener('change', () => {
      this.#state.activeWebViewId = this.#webViewSelect.value || null
      this.#state.webViewInspectionError = null
      this.#shownEtag = null
      this.refresh()
    })
    this.#locatorCheckForm?.addEventListener('submit', event => {
      event.preventDefault()
      this.#checkLocator()
    })

    if (continuousRefresh) {
      this.#refreshContinuously()
      setInterval(() => this.#fetchDevices().catch(() => {}), Inspector.#DEVICE_LIST_REFRESH_MS)
    }
    this.#loadDevices()
  }

  async refresh(forceWebViewDiscovery = false) {
    if (!this.#state.activeId) return
    if (this.#refreshInFlight) return
    this.#refreshInFlight = true
    this.#setRefreshButtonDisabled(true)

    try {
      const query = new URLSearchParams({ scale: this.#screenshotPane.preferredScreenshotScale() })
      if (!forceWebViewDiscovery && this.#shownEtag) {
        query.set('etag', this.#shownEtag)
      }
      const res = await fetch(`/api/inspect?${query}`)
      if (res.status === 503) return  // another inspect in flight, skip this tick — no state changed yet
      if (res.status === 304) {
        const webViewError = this.#state.pageMode === 'webview'
          ? await this.#refreshWebViewElements(forceWebViewDiscovery)
          : this.#state.webViewDiscoveryError
        const message = webViewError
          ? `Webview unavailable: ${webViewError}`
          : `${this.#state.elements.length} elements`
        this.#setStatus(message, webViewError ? 'error' : '')
        this.#consecutiveErrors = 0
        return
      }
      this.#setStatus('Loading...', 'loading')
      if (this.#screenshotPane.isScreenshotHidden) {
        this.#screenshotPane.showPlaceholder('Loading screenshot...', '', true)
      }
      if (res.status === 409) {
        this.#shownEtag = null
        this.#state.activeId = null
        this.#state.elements = []
        this.#state.nativeElements = []
        this.#state.webViews = []
        this.#state.webViewsLoaded = false
        this.#state.webViewDiscoveryError = null
        this.#state.webViewInspectionError = null
        this.#state.activeWebViewId = null
        this.#state.hiddenIndices = new Set()
        this.#state.selectedIndex = null
        this.#screenshotPane.showPlaceholder('Device disconnected', 'Select a device to continue')
        this.#elementsPane.render([], new Set())
        this.#screenshotPane.renderHighlights([], new Set(), null)
        this.#setStatus('Device disconnected', 'error')
        this.#renderDevicePicker()
        this.#renderWebViewPicker([])
        return
      }
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? res.statusText)
      }
      const data = await res.json()
      const screenChanged = data.etag !== this.#shownEtag
      this.#state.nativeElements = data.elements ?? []
      this.#state.logicalWidth = data.screen?.width ?? 0
      this.#state.logicalHeight = data.screen?.height ?? 0

      this.#screenshotPane.showScreenshot(data.screenshot, this.#state.logicalWidth, this.#state.logicalHeight, data.screen?.scale ?? 0)
      if (this.#state.pageMode === 'native') {
        this.#state.selectedIndex = null
        this.#detailPane.hide()
        this.#renderElements(this.#state.nativeElements)
      }
      const webViewError = await this.#refreshWebViewElements(forceWebViewDiscovery)
      if (screenChanged) {
        this.#screenshotPane.clearLocatorHighlights()
        this.#locatorCheckStatus && (this.#locatorCheckStatus.textContent = '')
      }
      this.#setStatus(webViewError ? `Webview unavailable: ${webViewError}` : `${this.#state.elements.length} elements`, webViewError ? 'error' : '')
      this.#shownEtag = data.etag ?? null
      this.#consecutiveErrors = 0
    } catch (err) {
      this.#consecutiveErrors++
      this.#setStatus('Refresh failed: ' + err.message, 'error')
      if (this.#screenshotPane.isScreenshotHidden) {
        this.#screenshotPane.showPlaceholder('Could not load screenshot', err.message)
      }
      // A fixed refresh has no toggle to turn it back on, so it keeps retrying instead.
      if (!this.#isContinuousRefresh && this.#consecutiveErrors >= Inspector.#MAX_CONSECUTIVE_ERRORS) {
        this.#stopAutoRefresh()
        this.#setStatus(`Auto-refresh stopped after ${this.#consecutiveErrors} consecutive failures`, 'error')
      }
    } finally {
      this.#refreshInFlight = false
      this.#setRefreshButtonDisabled(false)
    }
  }

  async #loadDevices() {
    try {
      await this.#fetchDevices()
      if (this.#state.activeId) {
        await this.refresh()
      }
    } catch (err) {
      this.#setStatus('Could not load devices: ' + err.message, 'error')
    }
  }

  async #discoverWebViews() {
    const previous = this.#state.webViews.find(webView => webView.id === this.#state.activeWebViewId)
    const response = await fetch('/api/webviews')
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? response.statusText)
    this.#state.webViews = data.webViews ?? []
    this.#state.webViewsLoaded = true
    this.#state.webViewDiscoveryError = null
    const active = this.#state.webViews.find(webView => webView.id === this.#state.activeWebViewId)
      ?? (previous?.bundleId && this.#state.webViews.find(webView => webView.bundleId === previous.bundleId && webView.url === previous.url))
      ?? (previous?.bundleId && this.#state.webViews.find(webView => webView.bundleId === previous.bundleId))
      ?? (previous?.processName && this.#state.webViews.find(webView => webView.processName === previous.processName))
      ?? this.#state.webViews.find(webView => webView.isVisible)
      ?? this.#state.webViews[0]
    this.#state.activeWebViewId = active?.id ?? null
    this.#renderWebViewPicker(this.#state.webViews)
  }

  async #refreshWebViewElements(forceDiscovery) {
    let error = this.#state.webViewDiscoveryError
    if (!this.#state.webViewsLoaded || forceDiscovery) {
      try {
        await this.#discoverWebViews()
        error = null
      } catch (err) {
        this.#state.webViews = []
        this.#state.activeWebViewId = null
        this.#state.webViewsLoaded = true
        this.#state.webViewDiscoveryError = err.message
        error = err.message
        this.#renderWebViewPicker([])
      }
    } else {
      this.#renderWebViewPicker(this.#state.webViews)
    }

    if (!error && this.#state.pageMode === 'webview' && this.#state.activeWebViewId) {
      try {
        await this.#renderPageElements()
        this.#state.webViewInspectionError = null
      } catch (err) {
        error = `Webview inspection failed: ${err.message}`
        this.#state.webViewInspectionError = error
        const fallbackElements = this.#state.pageMode === 'webview' ? [] : this.#state.nativeElements
        if (this.#state.elements !== fallbackElements) this.#renderElements(fallbackElements)
      }
    }
    if (this.#state.pageMode === 'native' && this.#state.elements !== this.#state.nativeElements) {
      this.#renderElements(this.#state.nativeElements)
    }
    return error ?? (this.#state.pageMode === 'webview' ? this.#state.webViewInspectionError : null)
  }

  async #fetchDevices() {
    const res = await fetch('/api/devices')
    if (!res.ok) throw new Error(`Device list failed: ${res.status}`)
    const data = await res.json()
    const prevActiveId = this.#state.activeId
    this.#state.devices = data.devices ?? []
    this.#state.activeId = data.activeId ?? null
    if (this.#state.activeId !== prevActiveId) {
      this.#shownEtag = null
      this.#userOverrides.clear()
      this.#state.webViews = []
      this.#state.webViewsLoaded = false
      this.#state.webViewDiscoveryError = null
      this.#state.webViewInspectionError = null
      this.#state.activeWebViewId = null
    }
    this.#renderDevicePicker()
    if (prevActiveId && !this.#state.activeId) {
      this.#shownEtag = null
      this.#state.elements = []
      this.#state.nativeElements = []
      this.#state.webViews = []
      this.#state.webViewsLoaded = false
      this.#state.webViewDiscoveryError = null
      this.#state.webViewInspectionError = null
      this.#state.activeWebViewId = null
      this.#state.selectedIndex = null
      this.#state.hiddenIndices = new Set()
      this.#elementsPane.render([], new Set())
      this.#renderWebViewPicker([])
      this.#screenshotPane.showPlaceholder('Device disconnected', 'Select a device to continue')
      this.#setStatus('Device disconnected', 'error')
    }
  }

  #renderDevicePicker() {
    // Every change of activeId re-renders the picker, so this is the one place to report it.
    this.#onActiveDeviceChangeCb?.(this.#state.devices.find(d => d.id === this.#state.activeId) ?? null)
    const currentIds = [...this.#deviceSelect.options].filter(o => o.value).map(o => o.value)
    const newIds = this.#state.devices.map(d => d.id)
    const sameList = currentIds.length === newIds.length && currentIds.every((id, i) => id === newIds[i])
    if (sameList && this.#deviceSelect.value === (this.#state.activeId ?? '')) return

    this.#deviceSelect.innerHTML = ''
    if (this.#state.devices.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No devices connected'
      this.#deviceSelect.appendChild(opt)
      return
    }
    if (!this.#state.activeId) {
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = 'Select a device'
      placeholder.disabled = true
      placeholder.selected = true
      this.#deviceSelect.appendChild(placeholder)
    }
    for (const d of this.#state.devices) {
      const opt = document.createElement('option')
      opt.value = d.id
      opt.dataset.platform = d.platform
      opt.textContent = `${d.name} (${d.platform}, ${d.type})`
      if (d.id === this.#state.activeId) opt.selected = true
      this.#deviceSelect.appendChild(opt)
    }
  }

  async #connectDevice(device) {
    if (this.#connectInFlight) return
    this.#connectInFlight = true
    this.#setStatus('Connecting...', 'loading')
    this.#shownEtag = null
    this.#screenshotPane.showPlaceholder('Connecting...', device.name ?? device.id, true)
    this.#setRefreshButtonDisabled(true)
    this.#deviceSelect.disabled = true
    try {
      // The server only accepts JSON POSTs (it keeps other sites from driving the device), hence the empty body.
      const res = await fetch(`/api/devices/select?${new URLSearchParams({ device: device.id })}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? res.statusText)
      }
      this.#state.activeId = device.id
      this.#userOverrides.clear()
      this.#state.webViews = []
      this.#state.webViewsLoaded = false
      this.#state.webViewDiscoveryError = null
      this.#state.webViewInspectionError = null
      this.#state.activeWebViewId = null
      this.#renderDevicePicker()
      await this.refresh()
    } catch (err) {
      this.#setStatus('Connect failed: ' + err.message, 'error')
      this.#screenshotPane.showPlaceholder('Connect failed', err.message)
      this.#renderDevicePicker()
    } finally {
      this.#connectInFlight = false
      this.#deviceSelect.disabled = false
      this.#setRefreshButtonDisabled(false)
    }
  }

  #selectElement(index) {
    this.#state.selectedIndex = index
    this.#screenshotPane.setSelectedIndex(index)
    this.#elementsPane.setSelectedIndex(index)
    const el = this.#state.elements.find(e => e.index === index)
    this.#detailPane.show(el ?? null)
  }

  #renderWebViewPicker(webViews) {
    if (!this.#webViewSelect) return
    const previousId = this.#state.activeWebViewId
    this.#webViewSelect.innerHTML = ''
    if (webViews.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = 'No webviews found'
      this.#webViewSelect.appendChild(option)
      this.#state.activeWebViewId = null
    } else {
      for (const webView of webViews) {
        const option = document.createElement('option')
        option.value = webView.id
        const owner = webView.bundleId || webView.processName
        const label = webView.title || webView.url || webView.id
        const visibility = webView.isVisible === false ? ' [hidden]' : ''
        option.textContent = `${label}${owner ? ` (${owner})` : ''}${visibility}`
        option.title = [webView.url, owner].filter(Boolean).join('\n') || webView.id
        this.#webViewSelect.appendChild(option)
      }
      this.#state.activeWebViewId = webViews.some(webView => webView.id === previousId)
        ? previousId
        : webViews[0].id
    }
    this.#syncPagePicker()
  }

  #syncPagePicker() {
    if (!this.#viewModeSelect || !this.#webViewSelect) return
    const webViewOption = this.#viewModeSelect.querySelector('option[value="webview"]')
    webViewOption.disabled = this.#state.webViews.length === 0
    if (webViewOption.disabled && this.#state.pageMode === 'webview') {
      this.#state.pageMode = 'native'
      this.#viewModeSelect.value = 'native'
    }
    this.#viewModeSelect.value = this.#state.pageMode
    this.#webViewSelect.hidden = this.#state.pageMode !== 'webview'
    this.#webViewSelect.disabled = this.#state.webViews.length === 0
    this.#webViewSelect.value = this.#state.activeWebViewId ?? ''
  }

  async #renderPageElements(retryStaleTarget = true) {
    let elements
    if (this.#state.pageMode === 'webview' && this.#state.activeWebViewId) {
      const requestedWebViewId = this.#state.activeWebViewId
      const query = new URLSearchParams({ webViewId: requestedWebViewId })
      const res = await fetch(`/api/webview/inspect?${query}`)
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? res.statusText
        if (retryStaleTarget && res.status === 404 && message.includes('was not found')) {
          await this.#discoverWebViews()
          if (this.#state.activeWebViewId) return this.#renderPageElements(false)
        }
        throw new Error(message)
      }
      elements = data.elements ?? []
      this.#state.webViews = this.#state.webViews.map(webView =>
        webView.id === data.webView.id ? data.webView : webView,
      )
      this.#renderWebViewPicker(this.#state.webViews)
    } else {
      elements = this.#state.nativeElements
    }

    if (JSON.stringify(this.#state.elements) !== JSON.stringify(elements)) {
      this.#renderElements(elements)
    }
  }

  #renderElements(elements) {
    this.#state.elements = elements
    this.#state.selectedIndex = null
    this.#detailPane.hide()
    const liveKeys = new Set(this.#state.elements.filter(el => el.locator).map(el => locatorKey(el.locator)))
    for (const key of this.#userOverrides.keys()) {
      if (!liveKeys.has(key)) this.#userOverrides.delete(key)
    }
    this.#state.hiddenIndices = this.#computeHiddenIndices()
    this.#elementsPane.render(this.#state.elements, this.#state.hiddenIndices)
    this.#screenshotPane.renderHighlights(this.#state.elements, this.#state.hiddenIndices, null)
  }

  async #locateWebViewXPath(locator, retryStaleTarget = true) {
    const response = await fetch('/api/webview/locate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webViewId: this.#state.activeWebViewId, locator }),
    })
    const data = await response.json()
    if (!response.ok) {
      const message = data.error ?? response.statusText
      if (retryStaleTarget && response.status === 404 && message.includes('was not found')) {
        await this.#discoverWebViews()
        if (this.#state.activeWebViewId) return this.#locateWebViewXPath(locator, false)
      }
      throw new Error(message)
    }
    return data.matches ?? []
  }

  async #checkLocator() {
    const locator = this.#locatorInput?.value.trim()
    if (!locator) return
    this.#locatorCheckButton.disabled = true
    this.#locatorCheckStatus.textContent = 'Checking...'
    this.#locatorCheckStatus.className = ''
    this.#screenshotPane.clearLocatorHighlights()
    try {
      const localMatches = this.#state.elements.filter(element => matchesLocatorSuggestion(element, locator))
      let bounds = localMatches.map(element => element.bounds)
      const isPlaywrightLocator = /^(?:getBy(?:TestId|Role|Text|Label|Placeholder|Title)\(|locator\()/.test(locator)
      if (bounds.length === 0 && this.#state.pageMode === 'native' && !isPlaywrightLocator) {
        bounds = nativeXPathBounds(this.#state.elements, locator)
      } else if (bounds.length === 0 && this.#state.pageMode === 'webview' && this.#state.activeWebViewId
          && !isPlaywrightLocator) {
        bounds = await this.#locateWebViewXPath(locator)
      }
      this.#screenshotPane.showLocatorHighlights(bounds)
      this.#locatorCheckStatus.textContent = bounds.length
        ? `${bounds.length} match${bounds.length === 1 ? '' : 'es'}`
        : 'No visible matches on the current page'
    } catch (err) {
      this.#locatorCheckStatus.textContent = err.message
      this.#locatorCheckStatus.className = 'error'
    } finally {
      this.#locatorCheckButton.disabled = false
    }
  }

  #toggleHidden(index) {
    const el = this.#state.elements.find(el => el.index === index)
    const key = el?.locator ? locatorKey(el.locator) : null
    const nowHidden = this.#state.hiddenIndices.has(index)
    // Only persist overrides for unique locator keys — shared keys would affect all duplicates.
    const isDupe = key ? buildDuplicateSet(this.#state.elements).has(key) : false

    if (nowHidden) {
      this.#state.hiddenIndices.delete(index)
      if (key && !isDupe) this.#userOverrides.set(key, 'visible')
    } else {
      this.#state.hiddenIndices.add(index)
      if (key && !isDupe) this.#userOverrides.set(key, 'hidden')
    }

    this.#screenshotPane.renderHighlights(this.#state.elements, this.#state.hiddenIndices, this.#state.selectedIndex)
    this.#elementsPane.updateRowVisibility(index, this.#state.hiddenIndices.has(index))
  }

  #computeHiddenIndices() {
    const dupes = buildDuplicateSet(this.#state.elements)
    return new Set(
      this.#state.elements
        .filter(el => {
          const key = el.locator ? locatorKey(el.locator) : null
          const override = key && !dupes.has(key) ? this.#userOverrides.get(key) : undefined
          if (override === 'visible') return false
          if (override === 'hidden') return true
          return el.locator?.kind === 'testId' && DEFAULT_HIDDEN_TESTIDS.has(el.locator.value)
        })
        .map(el => el.index)
    )
  }

  #applyAutoRefresh() {
    clearInterval(this.#autoRefreshTimer)
    this.#autoRefreshTimer = null
    this.#autoRefreshInterval.disabled = !this.#autoRefreshToggle.checked
    this.#consecutiveErrors = 0  // reset when user manually reconfigures auto-refresh
    if (this.#autoRefreshToggle.checked) {
      this.#startRefreshTimer(Number(this.#autoRefreshInterval.value))
    }
  }

  // Back-to-back refreshes. A refresh that returns quickly (no device, error, another one
  // in flight) is padded to MIN_FRAME_MS so the loop never spins.
  async #refreshContinuously() {
    for (;;) {
      const startedAt = performance.now()
      await this.refresh()
      const remainingMs = Inspector.#MIN_FRAME_MS - (performance.now() - startedAt)
      if (remainingMs > 0) {
        await new Promise(resolve => setTimeout(resolve, remainingMs))
      }
    }
  }

  #startRefreshTimer(ms) {
    this.#autoRefreshTimer = setInterval(async () => {
      if (this.#tickInFlight) return
      this.#tickInFlight = true
      try {
        await this.#fetchDevices().catch(() => {})
        await this.refresh()
      } finally {
        this.#tickInFlight = false
      }
    }, ms)
  }

  #setRefreshButtonDisabled(isDisabled) {
    if (this.#refreshBtn) {
      this.#refreshBtn.disabled = isDisabled
    }
  }

  // Called from the error path only — unregisters the timer and unchecks the toggle.
  #stopAutoRefresh() {
    clearInterval(this.#autoRefreshTimer)
    this.#autoRefreshTimer = null
    this.#autoRefreshToggle.checked = false
    this.#autoRefreshInterval.disabled = true
  }

  #setStatus(msg, type = '') {
    this.#statusBar.textContent = msg
    this.#statusBar.className = type
  }
}

// ---- Theme ----

export function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name)
  localStorage.setItem('mobilewright-inspector-theme', name)
  const sel = document.getElementById('theme-select')
  if (sel) sel.value = name
}

document.getElementById('theme-select')?.addEventListener('change', e => applyTheme(e.target.value))

// ---- Resizable panes ----

const KEYBOARD_RESIZE_STEP = 16

// direction: 1 when the pane is left of its splitter, -1 when right of it.
// CSS min/max-width on the pane does the clamping.
// axis: 'x' resizes the pane's width (vertical splitter), 'y' its height (horizontal splitter).
export function makeResizable(splitter, pane, cssVar, direction, axis = 'x') {
  const main = splitter.parentElement
  const storageKey = 'mobilewright-inspector' + cssVar
  const isVertical = axis === 'y'
  const paneSize = () => isVertical ? pane.offsetHeight : pane.offsetWidth
  const pointerPos = ev => isVertical ? ev.clientY : ev.clientX
  const setWidth = px => {
    main.style.setProperty(cssVar, px + 'px')
    localStorage.setItem(storageKey, paneSize())
  }

  const saved = localStorage.getItem(storageKey)
  if (saved) {
    main.style.setProperty(cssVar, saved + 'px')
  }

  splitter.addEventListener('pointerdown', e => {
    e.preventDefault()
    splitter.setPointerCapture(e.pointerId)
    splitter.classList.add('dragging')
    const startPos = pointerPos(e)
    const startSize = paneSize()
    const onMove = ev => setWidth(startSize + (pointerPos(ev) - startPos) * direction)
    splitter.addEventListener('pointermove', onMove)
    splitter.addEventListener('lostpointercapture', () => {
      splitter.removeEventListener('pointermove', onMove)
      splitter.classList.remove('dragging')
    }, { once: true })
  })

  splitter.addEventListener('keydown', e => {
    const keys = isVertical ? { ArrowUp: -KEYBOARD_RESIZE_STEP, ArrowDown: KEYBOARD_RESIZE_STEP } : { ArrowLeft: -KEYBOARD_RESIZE_STEP, ArrowRight: KEYBOARD_RESIZE_STEP }
    const step = keys[e.key]
    if (step) {
      e.preventDefault()
      setWidth(paneSize() + step * direction)
    }
  })
}
