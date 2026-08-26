import electronPath from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(import.meta.dirname, '..')
const userData = await mkdtemp(join(tmpdir(), 'dji-cloud-studio-smoke-'))
const screenshotPath = process.env.DJI_STUDIO_SCREENSHOT || join(tmpdir(), 'dji-cloud-studio-smoke.png')
const screenshotBase = screenshotPath.replace(/\.png$/i, '')
const packagedExecutable = process.env.DJI_STUDIO_EXECUTABLE
  ? resolve(projectRoot, process.env.DJI_STUDIO_EXECUTABLE)
  : undefined
const errors = []
const layouts = []

const electronApp = await electron.launch({
  executablePath: packagedExecutable || electronPath,
  args: packagedExecutable ? [`--user-data-dir=${userData}`] : [projectRoot, `--user-data-dir=${userData}`],
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
})

try {
  const window = await electronApp.firstWindow()
  window.on('pageerror', (error) => errors.push(error.message))
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })

  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((instance) => instance.setContentSize(1024, 680))
  await window.waitForFunction(
    () => window.innerWidth === 1024 && window.innerHeight === 680,
    undefined,
    { timeout: 5_000 },
  )

  const assertTooltip = async (name) => {
    const control = window.getByRole('button', { name, exact: true }).first()
    await control.hover()
    const tooltip = window.getByRole('tooltip')
    await tooltip.waitFor({ state: 'visible' })
    const text = await tooltip.textContent()
    if (text !== name) errors.push(`Tooltip for ${name} displayed ${JSON.stringify(text)}`)
    await window.mouse.move(500, 350)
    await tooltip.waitFor({ state: 'hidden' })
  }

  await assertTooltip('设备工作台')
  await assertTooltip('添加设备')

  await window.getByRole('button', { name: '关于', exact: true }).click()
  const aboutDialog = window.getByRole('dialog', { name: '关于' })
  await aboutDialog.waitFor({ state: 'visible' })
  if (!(await aboutDialog.getByText('DJI Cloud Studio', { exact: true }).isVisible())) {
    errors.push('about: missing project name')
  }
  const authorLink = aboutDialog.getByRole('link', { name: 'Secret799' })
  if (!(await authorLink.isVisible())) {
    errors.push('about: missing author')
  }
  if (await authorLink.getAttribute('href') !== 'https://github.com/Secret799') {
    errors.push('about: incorrect author link')
  }
  await window.screenshot({ path: `${screenshotBase}-about.png` })
  await aboutDialog.getByRole('button', { name: '关闭', exact: true }).last().click()
  await aboutDialog.waitFor({ state: 'hidden' })

  const inspectLayout = async (view, selectors) => {
    const layout = await window.evaluate(
      ({ viewName, elementSelectors }) => ({
        view: viewName,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        elements: elementSelectors.map((selector) => {
          const element = document.querySelector(selector)
          if (!(element instanceof HTMLElement)) return { selector, missing: true }
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return {
            selector,
            missing: false,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflowX: style.overflowX,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          }
        }),
      }),
      { viewName: view, elementSelectors: selectors },
    )

    for (const element of layout.elements) {
      if (element.missing) {
        errors.push(`${view}: missing ${element.selector}`)
        continue
      }
      const clipsOverflow = ['hidden', 'clip'].includes(element.overflowX)
        && element.scrollWidth > element.clientWidth + 1
      if (clipsOverflow) {
        errors.push(
          `${view}: ${element.selector} clips horizontal content (${element.scrollWidth}px in ${element.clientWidth}px)`,
        )
      }
      if (element.left < -1 || element.right > layout.viewport.width + 1) {
        errors.push(
          `${view}: ${element.selector} is outside the viewport (${element.left}px..${element.right}px in ${layout.viewport.width}px)`,
        )
      }
    }

    layouts.push(layout)
  }

  await window.getByRole('button', { name: '添加设备' }).click()
  if (await window.locator('.device-modal select').first().inputValue() !== 'dock2') {
    errors.push('overview: new dock does not default to the Dock 2 field model')
  }
  await window.locator('.device-modal input').nth(0).fill('测试机场')
  await window.locator('.device-modal input').nth(1).fill('DOCK-SMOKE-001')
  await window.getByRole('button', { name: '保存设备' }).click()
  await window.locator('.telemetry-workspace').waitFor({ state: 'visible' })
  await window.locator('.toast').waitFor({ state: 'hidden', timeout: 6_000 })
  await window.waitForFunction(
    () => document.querySelectorAll('.subscription-toggle.enabled').length > 0,
    undefined,
    { timeout: 6_000 },
  )

  const enabledSubscriptionCount = await window.locator('.subscription-toggle.enabled').count()
  if (!enabledSubscriptionCount) errors.push('Expected generated subscriptions to be enabled')
  if (await window.locator('.subscription-delete').count()) {
    errors.push('overview: system subscriptions exposed delete controls')
  }
  if (await window.locator('.subscription-system-lock').count() !== enabledSubscriptionCount) {
    errors.push('overview: system subscriptions are missing non-deletable indicators')
  }
  await window.getByRole('button', { name: '全部禁用' }).click()
  await window.waitForFunction(() => document.querySelectorAll('.subscription-toggle.enabled').length === 0)
  await window.locator('.toast').waitFor({ state: 'hidden', timeout: 6_000 })
  await window.getByRole('button', { name: '全部启用' }).click()
  await window.waitForFunction(
    (expected) => document.querySelectorAll('.subscription-toggle.enabled').length === expected,
    enabledSubscriptionCount,
  )
  await window.locator('.toast').waitFor({ state: 'hidden', timeout: 6_000 })

  const profileId = await window.evaluate(async () => (await window.djiApi.profiles.list())[0]?.id)
  if (!profileId) {
    errors.push('overview: failed to resolve the smoke profile id')
  } else {
    const extraFields = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`extra_${String(index).padStart(2, '0')}`, index]),
    )
    const payload = JSON.stringify({
      data: {
        silent_mode: 1,
        cover_state: 1,
        supplement_light_state: 0,
        alarm_state: 1,
        battery_store_mode: 1,
        wireless_link: { link_workmode: 0 },
        environment_temperature: 23.5,
        gimbal_yaw: 12.5,
        camera_mode: 0,
        network_state: { type: 2, quality: 4, rate: 128.5 },
        air_conditioner: { air_conditioner_state: 10, switch_time: 5 },
        drone_battery_maintenance_info: {
          maintenance_state: 2,
          batteries: [{ capacity_percent: 88, temperature: 31.5 }],
        },
        drone_charge_state: { state: 1, capacity_percent: 88 },
        dongle_infos: [
          {
            imei: 'SMOKE-IMEI-001',
            esim_activate_state: 2,
            sim_slot: 1,
            esim_infos: [{ telecom_operator: 1, enabled: true }],
          },
        ],
        live_capacity: {
          available_video_number: 3,
          coexist_video_number_max: 2,
          device_list: [
            {
              sn: 'DOCK-SMOKE-001',
              camera_list: [
                {
                  camera_index: '165-0-0',
                  video_list: [{ video_index: 'normal-0', video_type: 'normal' }],
                },
              ],
            },
            {
              sn: 'AIR-SMOKE-001',
              camera_list: [
                {
                  camera_index: '81-0-0',
                  video_list: [
                    { video_index: 'wide-0', video_type: 'wide', switchable_video_types: ['wide', 'zoom'] },
                    { video_index: 'infrared-0', video_type: 'infrared' },
                  ],
                },
              ],
            },
          ],
        },
        maintain_status: {
          maintain_status_array: [
            {
              state: 0,
              last_maintain_type: 17,
              last_maintain_time: 1695684586,
              last_maintain_work_sorties: 42,
            },
            {
              state: 1,
              last_maintain_type: 18,
              last_maintain_time: 1725000000,
              last_maintain_work_sorties: 86,
            },
          ],
        },
        sub_device: {
          device_sn: 'AIR-SMOKE-001',
          device_online_status: 1,
          device_model_key: '0-91-1',
        },
        ...extraFields,
      },
      gateway: 'DOCK-SMOKE-001',
    })
    const runtimeEvent = {
      type: 'message',
      profileId,
      message: {
        id: 'smoke-dock2-properties',
        profileId,
        direction: 'in',
        topic: 'thing/product/DOCK-SMOKE-001/osd',
        payload,
        qos: 0,
        retain: false,
        timestamp: Date.now(),
        size: Buffer.byteLength(payload),
      },
    }

    await electronApp.evaluate(({ BrowserWindow }, event) => {
      for (const instance of BrowserWindow.getAllWindows()) {
        instance.webContents.send('runtime:event', event)
      }
    }, runtimeEvent)
    const statePayload = JSON.stringify({ data: { mode_code: 1, drc_state: 0, firmware_version: '01.00.0000' } })
    await electronApp.evaluate(({ BrowserWindow }, event) => {
      for (const instance of BrowserWindow.getAllWindows()) {
        instance.webContents.send('runtime:event', event)
      }
    }, {
      type: 'message',
      profileId,
      message: {
        id: 'smoke-dock2-state',
        profileId,
        direction: 'in',
        topic: 'thing/product/DOCK-SMOKE-001/state',
        payload: statePayload,
        qos: 1,
        retain: false,
        timestamp: Date.now(),
        size: Buffer.byteLength(statePayload),
      },
    })

    await window.waitForTimeout(800)
    const telemetryDebug = await window.evaluate(async (id) => ({
      selectedSn: document.querySelector('.device-facts > div:first-child strong')?.textContent,
      fieldCount: document.querySelectorAll('.telemetry-row').length,
      topics: (await window.djiApi.profiles.list()).find((item) => item.id === id)?.subscriptions.map((item) => item.topic),
    }), profileId)
    if (await window.locator('.device-switcher').count()) {
      errors.push('overview: redundant device switcher should not be rendered')
    }
    if (telemetryDebug.fieldCount < 52) {
      throw new Error(`Dock telemetry did not render: ${JSON.stringify(telemetryDebug)}`)
    }
    const dockTelemetry = await window.locator('.telemetry-workspace').textContent() ?? ''
    if (
      !dockTelemetry.includes('环境数据')
      || !dockTelemetry.includes('网络与通信')
      || !dockTelemetry.includes('运行信息')
      || !dockTelemetry.includes('设备信息')
      || !dockTelemetry.includes('运行与任务状态')
      || !dockTelemetry.includes('OSD')
      || !dockTelemetry.includes('STATE')
      || !dockTelemetry.includes('firmware_version')
    ) {
      errors.push(`overview: OSD and state fields were not grouped (${JSON.stringify(dockTelemetry)})`)
    }
    if (dockTelemetry.includes('drone_battery_maintenance_info') || dockTelemetry.includes('sub_device.device_sn')) {
      errors.push('overview: aircraft-owned relay fields remained on the dock telemetry view')
    }
    await window.waitForFunction(async (id) => {
      const profile = (await window.djiApi.profiles.list()).find((item) => item.id === id)
      return Boolean(
        profile?.subscriptions.some((item) => item.topic === 'thing/product/AIR-SMOKE-001/osd' && item.enabled)
        && profile.subscriptions.some((item) => item.topic === 'thing/product/AIR-SMOKE-001/state' && item.enabled),
      )
    }, profileId)

    const groupedSubscriptionCount = await window.locator('.subscription-toggle.enabled').count()
    const subscriptionGroup = window.locator('.subscription-group').filter({ hasText: '测试机场' }).first()
    const subscriptionGroupHeader = subscriptionGroup.locator('.subscription-group-header')
    const subscriptionGroupCollapse = subscriptionGroup.locator('.subscription-group-collapse')
    const subscriptionGroupRowCount = await subscriptionGroup.locator('.subscription-row').count()
    await subscriptionGroupCollapse.click()
    if (await subscriptionGroupCollapse.getAttribute('aria-expanded') !== 'false' || await subscriptionGroup.locator('.subscription-row').count()) {
      errors.push('overview: subscription group did not collapse')
    }
    await subscriptionGroupCollapse.click()
    if (await subscriptionGroupCollapse.getAttribute('aria-expanded') !== 'true'
      || await subscriptionGroup.locator('.subscription-row').count() !== subscriptionGroupRowCount) {
      errors.push('overview: subscription group did not expand')
    }
    await subscriptionGroupHeader.getByRole('button', { name: '禁用分组 Topic' }).click()
    await window.waitForFunction(
      (selector) => document.querySelector(selector)?.querySelectorAll('.subscription-toggle.enabled').length === 0,
      '.subscription-group',
    )
    await subscriptionGroupHeader.getByRole('button', { name: '启用分组 Topic' }).click()
    await window.waitForFunction(
      ({ selector, expected }) => document.querySelector(selector)?.querySelectorAll('.subscription-toggle.enabled').length === expected,
      { selector: '.subscription-group', expected: subscriptionGroupRowCount },
    )
    const dockRow = window.locator('.device-row').filter({ hasText: 'DOCK-SMOKE-001' })
    await dockRow.getByRole('button', { name: '禁用设备' }).click()
    await window.waitForFunction(async (id) => {
      const profile = (await window.djiApi.profiles.list()).find((item) => item.id === id)
      return profile?.devices.find((item) => item.sn === 'DOCK-SMOKE-001')?.enabled === false
    }, profileId)
    await window.waitForFunction(
      () => document.querySelector('.count-badge')?.textContent?.trim() === '0/0'
        && document.querySelectorAll('.device-row.disabled').length >= 2
        && document.querySelectorAll('.subscription-group').length === 0,
    )
    if (await window.locator('.subscription-group').count()) {
      errors.push('overview: disabling a gateway did not remove its subscription group')
    }
    const savedEnabledTopicCount = await window.evaluate(async (id) => {
      const profile = (await window.djiApi.profiles.list()).find((item) => item.id === id)
      return profile?.subscriptions.filter((item) => item.enabled).length ?? 0
    }, profileId)
    if (savedEnabledTopicCount !== groupedSubscriptionCount) {
      errors.push('overview: hiding a disabled device group changed its saved per-Topic switches')
    }
    if (await window.locator('.device-row.disabled').count() < 2) {
      errors.push('overview: disabling a gateway did not disable its child aircraft')
    }
    const aircraftRow = window.locator('.device-row').filter({ hasText: 'AIR-SMOKE-001' })
    if (!await aircraftRow.getByRole('button', { name: '已随上级设备禁用' }).isDisabled()) {
      errors.push('overview: inherited aircraft disable state remained interactive')
    }
    await dockRow.getByRole('button', { name: '启用设备' }).click()
    await window.waitForFunction(
      (expected) => document.querySelector('.count-badge')?.textContent?.trim() === `${expected}/${expected}`
        && document.querySelectorAll('.subscription-group').length === 1,
      groupedSubscriptionCount,
    )

    const groupedEvents = [
      { id: 'smoke-event-drc-1', method: 'drc_status_notify', data: { drc_state: 0 } },
      { id: 'smoke-event-hms', method: 'hms', data: { list: [{ code: '0x16100001' }] } },
      { id: 'smoke-event-drc-2', method: 'drc_status_notify', data: { drc_state: 1 } },
    ]
    for (const [index, groupedEvent] of groupedEvents.entries()) {
      const eventBody = JSON.stringify({ method: groupedEvent.method, data: groupedEvent.data })
      await electronApp.evaluate(({ BrowserWindow }, event) => {
        for (const instance of BrowserWindow.getAllWindows()) {
          instance.webContents.send('runtime:event', event)
        }
      }, {
        type: 'message',
        profileId,
        message: {
          id: groupedEvent.id,
          profileId,
          direction: 'in',
          topic: 'thing/product/DOCK-SMOKE-001/events',
          payload: eventBody,
          qos: 1,
          retain: false,
          timestamp: Date.now() + index,
          size: Buffer.byteLength(eventBody),
        },
      })
    }
    const eventsWorkbenchTab = window.locator('.device-tabs button').filter({ hasText: '事件' })
    await window.waitForFunction(
      () => document.querySelector('.device-tabs button:nth-child(2) small')?.textContent === '3',
    )
    await eventsWorkbenchTab.click()
    await window.locator('.event-workspace').waitFor({ state: 'visible' })
    const eventGroups = window.locator('.event-message-group')
    if (await eventGroups.count() !== 2) {
      errors.push('events: messages were not grouped by method')
    }
    const drcEventGroup = eventGroups.filter({ hasText: 'DRC 状态通知' })
    const hmsEventGroup = eventGroups.filter({ hasText: '设备告警' })
    if (await drcEventGroup.locator('summary > small').innerText() !== '2 条') {
      errors.push('events: DRC group count is incorrect')
    }
    if (!await drcEventGroup.evaluate((group) => group.open) || await hmsEventGroup.evaluate((group) => group.open)) {
      errors.push('events: only the newest message group should initially be expanded')
    }
    await hmsEventGroup.locator('summary').click()
    if (!await hmsEventGroup.evaluate((group) => group.open)) {
      errors.push('events: a message group could not be expanded')
    }
    const eventHeaderText = await window.locator('.event-workspace-header').innerText()
    if (!eventHeaderText.includes('2 种类型 · 共 3 条')) {
      errors.push(`events: grouped total is incorrect (${JSON.stringify(eventHeaderText)})`)
    }
    await inspectLayout('events', [
      'body',
      '.app-shell',
      '.workspace-content',
      '.event-workspace',
      '.event-group-list',
      '.event-message-group',
    ])
    await window.screenshot({ path: `${screenshotBase}-events.png` })
    await window.getByRole('button', { name: '遥测', exact: true }).click()
    await window.locator('.telemetry-workspace').waitFor({ state: 'visible' })

    const silentModeRow = window.locator('.telemetry-row').filter({ hasText: 'silent_mode' }).first()
    const silentModeValue = await silentModeRow.locator('.telemetry-field-value > strong').innerText()
    if (silentModeValue !== '静音模式 (1)') {
      errors.push(`overview: unexpected silent_mode value ${JSON.stringify(silentModeValue)}`)
    }

    const propertySetButton = silentModeRow.locator('.telemetry-property-set-button')
    if (await propertySetButton.count() !== 1) {
      errors.push('overview: writable telemetry field is missing its setting control')
    } else {
      await propertySetButton.evaluate((button) => {
        const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps$'))
        button[propsKey]?.onClick?.()
      })
      const propertyDialog = window.getByRole('dialog', { name: '设置机场静音模式' })
      await propertyDialog.waitFor({ state: 'visible' })
      if (await propertyDialog.locator('select').inputValue() !== '1') {
        errors.push('property set: current enum value was not selected')
      }
      const propertyDialogText = await propertyDialog.innerText()
      if (!propertyDialogText.includes('thing/product/DOCK-SMOKE-001/property/set')
        || !propertyDialogText.includes('DJI Dock 2 设备属性')) {
        errors.push(`property set: missing topic or metadata source (${JSON.stringify(propertyDialogText)})`)
      }
      await inspectLayout('property-set', [
        'body',
        '.modal-backdrop',
        '.property-set-modal',
        '.property-set-meta',
        '.property-set-field',
        '.property-set-footer',
      ])
      await window.screenshot({ path: `${screenshotBase}-property-set.png` })
      await propertyDialog.getByRole('button', { name: '关闭', exact: true }).last().click()
      await propertyDialog.waitFor({ state: 'hidden' })
    }

    await silentModeRow.locator('.field-help-button').hover()
    const tooltip = window.locator('.field-tooltip')
    await tooltip.waitFor({ state: 'visible', timeout: 3_000 })
    await window.waitForTimeout(180)
    const tooltipText = await tooltip.innerText()
    if (!tooltipText.includes('风扇转速降低') || !tooltipText.includes('可读写')) {
      errors.push('overview: Dock 2 field tooltip is missing official details')
    }
    const tooltipBox = await tooltip.boundingBox()
    if (
      !tooltipBox
      || tooltipBox.x < -1
      || tooltipBox.y < -1
      || tooltipBox.x + tooltipBox.width > 1025
      || tooltipBox.y + tooltipBox.height > 681
    ) {
      errors.push(`overview: field tooltip is outside the viewport (${JSON.stringify(tooltipBox)})`)
    }
    await window.screenshot({ path: `${screenshotBase}-field-tooltip.png` })

    await window.keyboard.press('Escape')
    await tooltip.waitFor({ state: 'hidden', timeout: 1_000 })

    await window.mouse.move(1010, 10)
    await silentModeRow.locator('.field-help-button').focus()
    await tooltip.waitFor({ state: 'visible', timeout: 1_000 })
    await window.mouse.move(1010, 10)
    await window.keyboard.press('Escape')
    await tooltip.waitFor({ state: 'hidden', timeout: 1_000 })

    const silentModeButton = silentModeRow.locator('.field-help-button')
    await silentModeButton.evaluate((button) => button.blur())
    await silentModeButton.focus()
    await tooltip.waitFor({ state: 'visible', timeout: 1_000 })
    await window.getByRole('tab', { name: /其他信息/ }).click()
    await tooltip.waitFor({ state: 'hidden', timeout: 1_000 })
    const telemetryCategoryTabs = window.locator('.telemetry-category-tabs')
    const telemetrySectionTabs = window.locator('#telemetry-panel-other .telemetry-section-tabs')
    const telemetrySectionPanels = window.locator('#telemetry-panel-other .telemetry-section-panels')
    const categoryTabsBeforeScroll = await telemetryCategoryTabs.boundingBox()
    const sectionTabsBeforeScroll = await telemetrySectionTabs.boundingBox()
    await telemetrySectionPanels.evaluate((element) => { element.scrollTop = 220 })
    await window.waitForTimeout(80)
    const categoryTabsAfterScroll = await telemetryCategoryTabs.boundingBox()
    const sectionTabsAfterScroll = await telemetrySectionTabs.boundingBox()
    const sectionPanelScrollTop = await telemetrySectionPanels.evaluate((element) => element.scrollTop)
    if (sectionPanelScrollTop <= 0) {
      errors.push('overview: telemetry detail panel did not scroll independently')
    }
    if (
      !categoryTabsBeforeScroll
      || !categoryTabsAfterScroll
      || Math.abs(categoryTabsBeforeScroll.y - categoryTabsAfterScroll.y) > 1
    ) {
      errors.push('overview: telemetry category tabs moved while the detail panel scrolled')
    }
    if (
      !sectionTabsBeforeScroll
      || !sectionTabsAfterScroll
      || Math.abs(sectionTabsBeforeScroll.y - sectionTabsAfterScroll.y) > 1
    ) {
      errors.push('overview: telemetry secondary tabs moved while the detail panel scrolled')
    }
    await telemetrySectionPanels.evaluate((element) => { element.scrollTop = 0 })

    await window.getByRole('tab', { name: /设备信息/ }).click()
    await window.getByRole('tab', { name: /机场设备/ }).click()
    const airConditionerRow = window.locator('.telemetry-row').filter({ hasText: 'air_conditioner.air_conditioner_state' }).first()
    const airConditionerValue = await airConditionerRow.locator('.telemetry-field-value > strong').innerText()
    if (airConditionerValue !== '风冷准备中 (10)') {
      errors.push(`overview: malformed-source enum was not repaired (${JSON.stringify(airConditionerValue)})`)
    }
    await airConditionerRow.locator('.field-help-button').hover()
    await tooltip.waitFor({ state: 'visible', timeout: 1_000 })
    const tooltipOverflow = await tooltip.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      pointerEvents: window.getComputedStyle(element).pointerEvents,
    }))
    if (tooltipOverflow.pointerEvents !== 'auto') {
      errors.push('overview: field tooltip cannot receive pointer input')
    }
    if (tooltipOverflow.scrollHeight > tooltipOverflow.clientHeight) {
      const box = await tooltip.boundingBox()
      if (box) {
        await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await window.mouse.wheel(0, 180)
        const scrollTop = await tooltip.evaluate((element) => element.scrollTop)
        if (scrollTop <= 0) errors.push('overview: long field tooltip cannot be scrolled')
      }
    }
    await window.mouse.move(1010, 10)
    await tooltip.waitFor({ state: 'hidden', timeout: 1_000 })

    await window.getByRole('tab', { name: /运维信息/ }).click()
    await window.locator('#telemetry-panel-maintenance').waitFor({ state: 'visible' })
    if (await window.locator('#telemetry-panel-maintenance .telemetry-section-panels').evaluate((element) => element.scrollTop) !== 0) {
      errors.push('overview: primary telemetry category did not reset the detail scroll position')
    }
    const maintenanceText = await window.locator('#telemetry-panel-maintenance').textContent() ?? ''
    if (
      !maintenanceText.includes('保养信息')
      || !maintenanceText.includes('maintain_status.maintain_status_array.0.state')
      || !maintenanceText.includes('maintain_status.maintain_status_array.1.state')
      || !maintenanceText.includes('last_maintain_type')
    ) {
      errors.push(`overview: maintenance fields were not grouped (${JSON.stringify(maintenanceText)})`)
    }
    const maintenanceArrayItems = window.locator('#telemetry-panel-maintenance .telemetry-array-item')
    if (await maintenanceArrayItems.count() !== 2) {
      errors.push('overview: array records were not rendered as expandable items')
    }
    const initialArrayOpenState = await maintenanceArrayItems.evaluateAll((items) => items.map((item) => item.open))
    if (initialArrayOpenState[0] !== true || initialArrayOpenState[1] !== false) {
      errors.push('overview: array records did not default to the first expanded item')
    }
    await maintenanceArrayItems.nth(1).locator('summary').click()
    if (!await maintenanceArrayItems.nth(1).evaluate((item) => item.open)) {
      errors.push('overview: array item could not be expanded')
    }
    await maintenanceArrayItems.nth(1).locator('summary').click()
    await window.screenshot({ path: `${screenshotBase}-maintenance.png` })

    const payloadEvents = [
      { id: 'smoke-payload-event-1', psdkIndex: 1, value: 'PSDK-ONE' },
      { id: 'smoke-payload-event-1b', psdkIndex: 1, value: 'PSDK-ONE-SECOND' },
      { id: 'smoke-payload-event-2', psdkIndex: 2, value: 'ENC:AAECA/8=' },
    ]
    for (const payloadEvent of payloadEvents) {
      const payloadEventBody = JSON.stringify({
        method: 'custom_data_transmission_from_psdk',
        data: { psdk_index: payloadEvent.psdkIndex, value: payloadEvent.value },
      })
      await electronApp.evaluate(({ BrowserWindow }, event) => {
        for (const instance of BrowserWindow.getAllWindows()) {
          instance.webContents.send('runtime:event', event)
        }
      }, {
        type: 'message',
        profileId,
        message: {
          id: payloadEvent.id,
          profileId,
          direction: 'in',
          topic: 'thing/product/DOCK-SMOKE-001/events',
          payload: payloadEventBody,
          qos: 1,
          retain: false,
          timestamp: Date.now(),
          size: Buffer.byteLength(payloadEventBody),
        },
      })
    }

    if (await window.locator('.device-tabs button').filter({ hasText: '负载' }).count()) {
      errors.push('dock: should not display the payload workbench tab')
    }

    const aircraftPayload = JSON.stringify({
      data: {
        battery: { capacity_percent: 76 },
        horizontal_speed: 5.4,
        latitude: 31.2304,
        longitude: 121.4737,
      },
      gateway: 'DOCK-SMOKE-001',
    })
    await electronApp.evaluate(({ BrowserWindow }, event) => {
      for (const instance of BrowserWindow.getAllWindows()) {
        instance.webContents.send('runtime:event', event)
      }
    }, {
      type: 'message',
      profileId,
      message: {
        id: 'smoke-aircraft-osd',
        profileId,
        direction: 'in',
        topic: 'thing/product/AIR-SMOKE-001/osd',
        payload: aircraftPayload,
        qos: 0,
        retain: false,
        timestamp: Date.now(),
        size: Buffer.byteLength(aircraftPayload),
      },
    })
    await window.locator('.device-row').filter({ hasText: 'AIR-SMOKE-001' }).click()
    await window.waitForFunction(() => {
      const telemetryText = document.querySelector('.telemetry-workspace')?.textContent ?? ''
      return telemetryText.includes('76 %')
        && telemetryText.includes('5.4 m/s')
        && telemetryText.includes('31.2304')
    })
    const aircraftWorkbenchTabs = window.locator('.device-tabs')
    for (const hiddenTab of ['事件', '最近指令', '控制中心']) {
      if (await aircraftWorkbenchTabs.locator('button').filter({ hasText: hiddenTab }).count()) {
        errors.push(`aircraft: should not display the ${hiddenTab} workbench tab`)
      }
    }
    await browserWindow.evaluate((instance) => instance.setContentSize(1440, 800))
    await window.waitForFunction(
      () => window.innerWidth === 1440 && window.innerHeight === 800,
      undefined,
      { timeout: 5_000 },
    )
    const payloadWorkbenchTab = window.locator('.device-tabs button').filter({ hasText: '负载' })
    if (await payloadWorkbenchTab.locator('small').innerText() !== '2') {
      errors.push('payload: aircraft badge should count distinct gateway psdk_index values')
    }
    await payloadWorkbenchTab.click()
    await window.locator('.payload-workspace').waitFor({ state: 'visible' })
    const rawPayloadText = await window.locator('.psdk-report-value pre').innerText()
    if (rawPayloadText !== 'ENC:AAECA/8=') errors.push(`payload: raw encrypted value changed (${JSON.stringify(rawPayloadText)})`)
    const payloadWorkspaceText = await window.locator('.payload-workspace').innerText()
    for (const expected of ['负载信息', 'PSDK 数据消息', 'PSDK 2', 'custom_data_transmission_from_psdk', 'ENC:AAECA/8=', '"psdk_index": 2']) {
      if (!payloadWorkspaceText.includes(expected)) errors.push(`payload: missing ${expected}`)
    }
    for (const unexpected of ['PSDK 负载控制', '发送自定义数据', 'custom_data_transmission_to_psdk', '喊话器', 'gimbal_yaw', 'camera_photo_take_progress', '获取负载控制权', '拍照', '云台回中']) {
      if (payloadWorkspaceText.includes(unexpected)) errors.push(`payload: should not contain ${unexpected}`)
    }
    const psdkTabs = window.getByRole('tab', { name: /^PSDK / })
    if (await psdkTabs.count() !== 2 || await window.getByRole('tab', { name: 'PSDK 2' }).getAttribute('aria-selected') !== 'true') {
      errors.push('payload: psdk_index tabs did not select the current payload')
    }
    await window.getByRole('tab', { name: 'PSDK 1' }).click()
    const selectedPayloadText = await window.locator('.payload-workspace').innerText()
    if (!selectedPayloadText.includes('PSDK-ONE') || selectedPayloadText.includes('ENC:AAECA/8=')) {
      errors.push('payload: psdk_index tab did not filter payload details and messages')
    }
    await inspectLayout('payload', [
      'body',
      '.app-shell',
      '.workspace-content',
      '.payload-workspace',
      '.payload-dashboard',
      '.payload-info-panel',
      '.payload-event-panel',
      '.psdk-index-tabs',
    ])
    const payloadPanelBoxes = await Promise.all([
      window.locator('.payload-info-panel').boundingBox(),
      window.locator('.payload-event-panel').boundingBox(),
    ])
    if (
      !payloadPanelBoxes[0]
      || !payloadPanelBoxes[1]
      || Math.abs(payloadPanelBoxes[0].y - payloadPanelBoxes[1].y) > 1
      || payloadPanelBoxes[1].x <= payloadPanelBoxes[0].x + payloadPanelBoxes[0].width
    ) {
      errors.push(`payload: desktop panels are not arranged left and right (${JSON.stringify(payloadPanelBoxes)})`)
    }
    await window.screenshot({ path: `${screenshotBase}-payload.png` })
    await browserWindow.evaluate((instance) => instance.setContentSize(1024, 680))
    await window.waitForFunction(
      () => window.innerWidth === 1024 && window.innerHeight === 680,
      undefined,
      { timeout: 5_000 },
    )
    await window.getByRole('button', { name: '遥测', exact: true }).click()
    await window.locator('.telemetry-workspace').waitFor({ state: 'visible' })
    const aircraftTelemetry = await window.locator('.telemetry-workspace').textContent() ?? ''
    if (aircraftTelemetry.includes('environment_temperature')) {
      errors.push('overview: aircraft telemetry should not display dock environment temperature')
    }
    const deviceFacts = await window.locator('.device-facts').innerText()
    if (!deviceFacts.includes('DJI Matrice 3TD')) {
      errors.push(`overview: aircraft model key was not mapped (${JSON.stringify(deviceFacts)})`)
    }
    if (deviceFacts.includes('所属网关')) {
      errors.push('overview: gateway should not be displayed in the device summary')
    }
    await window.getByRole('tab', { name: /设备信息/ }).click()
    await window.locator('#telemetry-panel-device').waitFor({ state: 'visible' })
    const aircraftDeviceText = await window.locator('#telemetry-panel-device').innerText()
    if (!aircraftDeviceText.includes('drone_battery_maintenance_info.batteries.0.temperature')) {
      errors.push(`overview: dock-relayed aircraft battery data was not moved to the aircraft (${JSON.stringify(aircraftDeviceText)})`)
    }
    await window.getByRole('tab', { name: /飞行信息/ }).click()
    await window.locator('#telemetry-panel-operation').waitFor({ state: 'visible' })
    if (await window.locator('#telemetry-panel-device').isVisible()) {
      errors.push('overview: telemetry category tabs display more than one panel')
    }
  }

  await inspectLayout('overview', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.overview-view',
    '.telemetry-workspace',
    '.telemetry-category-tabs',
    '.telemetry-category-panels',
    '.telemetry-section-tabs',
    '.telemetry-section-panels',
  ])
  await window.screenshot({ path: `${screenshotBase}-overview.png` })

  await window.locator('.device-row').filter({ hasText: 'DOCK-SMOKE-001' }).click()
  await window.waitForFunction(
    () => document.querySelector('.device-facts > div:first-child strong')?.textContent === 'DOCK-SMOKE-001',
  )
  if (await window.locator('.remote-tab .command-history-panel').count()) {
    errors.push('overview: recent commands should not remain inside the telemetry tab')
  }
  const deviceTabLabels = await window.locator('.device-tabs button span').allTextContents()
  const messagesTabIndex = deviceTabLabels.indexOf('MQTT 消息')
  const historyTabIndex = deviceTabLabels.indexOf('最近指令')
  if (messagesTabIndex < 0 || historyTabIndex !== messagesTabIndex + 1) {
    errors.push(`overview: recent commands should follow MQTT messages (${JSON.stringify(deviceTabLabels)})`)
  }
  if (profileId) {
    const commandTimestamp = Date.now()
    const commandMessages = [
      {
        id: 'smoke-command-request',
        profileId,
        direction: 'out',
        topic: 'thing/product/DOCK-SMOKE-001/services',
        payload: JSON.stringify({
          tid: 'smoke-command-tid',
          bid: 'smoke-command-bid',
          method: 'cover_open',
          data: { target: 'smoke-request-value' },
        }),
        qos: 1,
        retain: false,
        timestamp: commandTimestamp,
      },
      {
        id: 'smoke-command-response',
        profileId,
        direction: 'in',
        topic: 'thing/product/DOCK-SMOKE-001/services_reply',
        payload: JSON.stringify({
          tid: 'smoke-command-tid',
          bid: 'smoke-command-bid',
          method: 'cover_open',
          data: { result: 0, detail: 'smoke-response-value' },
        }),
        qos: 1,
        retain: false,
        timestamp: commandTimestamp + 45,
      },
    ].map((message) => ({ ...message, size: Buffer.byteLength(message.payload) }))
    await electronApp.evaluate(({ BrowserWindow }, messages) => {
      for (const instance of BrowserWindow.getAllWindows()) {
        for (const message of messages) {
          instance.webContents.send('runtime:event', { type: 'message', profileId: message.profileId, message })
        }
      }
    }, commandMessages)
  }
  await window.getByRole('button', { name: /最近指令/ }).click()
  await window.locator('.history-workspace .command-history-panel').waitFor({ state: 'visible' })
  if (profileId) {
    const commandHistoryItem = window.locator('.command-history-item').first()
    await commandHistoryItem.waitFor({ state: 'visible' })
    if (await commandHistoryItem.getAttribute('open') !== null) {
      errors.push('history: command details should be collapsed by default')
    }
    await commandHistoryItem.locator('summary').click()
    await window.waitForFunction(() => document.querySelector('.command-history-item')?.hasAttribute('open'))
    const commandHistoryText = await commandHistoryItem.innerText()
    for (const expected of [
      '发送信息',
      '返回信息',
      'thing/product/DOCK-SMOKE-001/services',
      'thing/product/DOCK-SMOKE-001/services_reply',
      'smoke-request-value',
      'smoke-response-value',
      '45 ms',
    ]) {
      if (!commandHistoryText.includes(expected)) errors.push(`history: missing ${expected}`)
    }
  }
  await inspectLayout('history', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.history-workspace',
    '.command-history-panel',
    '.command-history-item',
    '.command-message-pair',
  ])
  await window.screenshot({ path: `${screenshotBase}-history.png` })

  await window.getByRole('button', { name: 'MQTT 消息' }).click()
  await window.locator('.mqtt-console').waitFor({ state: 'visible' })
  await inspectLayout('messages', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.mqtt-console',
    '.console-toolbar',
    '.console-content',
    '.publish-composer',
  ])
  await window.screenshot({ path: `${screenshotBase}-messages.png` })

  await browserWindow.evaluate((instance) => instance.setContentSize(1440, 800))
  await window.waitForFunction(
    () => window.innerWidth === 1440 && window.innerHeight === 800,
    undefined,
    { timeout: 5_000 },
  )
  await window.getByRole('button', { name: '控制中心', exact: true }).click()
  await window.locator('.command-center').waitFor({ state: 'visible' })
  if (await window.getByText('请求响应记录', { exact: true }).count()) {
    errors.push('commands: duplicated request and response history is still visible')
  }
  await window.locator('.remote-debug-console').waitFor({ state: 'visible' })
  const lockedDebugText = await window.locator('.remote-debug-console').innerText()
  if (!lockedDebugText.includes('现场调试中') || !lockedDebugText.includes('请先进入远程调试模式')) {
    errors.push(`commands: remote operations were not locked outside remote debug mode (${JSON.stringify(lockedDebugText)})`)
  }
  if (await window.locator('.debug-operation-card button:not([disabled])').count()) {
    errors.push('commands: state-changing debug operations remained enabled before remote debug mode')
  }
  await window.screenshot({ path: `${screenshotBase}-commands-debug-locked.png` })

  if (profileId) {
    const remoteDebugPayload = JSON.stringify({ data: { mode_code: 2 } })
    await electronApp.evaluate(({ BrowserWindow }, event) => {
      for (const instance of BrowserWindow.getAllWindows()) {
        instance.webContents.send('runtime:event', event)
      }
    }, {
      type: 'message',
      profileId,
      message: {
        id: 'smoke-dock2-remote-debug',
        profileId,
        direction: 'in',
        topic: 'thing/product/DOCK-SMOKE-001/state',
        payload: remoteDebugPayload,
        qos: 1,
        retain: false,
        timestamp: Date.now(),
        size: Buffer.byteLength(remoteDebugPayload),
      },
    })
    await window.locator('.debug-mode-gate.active').waitFor({ state: 'visible' })
    const activeDebugText = await window.locator('.remote-debug-console').innerText()
    const activeQuickDebugText = await window.locator('.debug-operation-grid').first().innerText()
    if (
      !activeDebugText.includes('退出远程调试')
      || !activeQuickDebugText.includes('关闭舱盖')
      || !activeQuickDebugText.includes('飞机关机')
      || !activeQuickDebugText.includes('停止充电')
      || !activeDebugText.includes('关闭声光报警')
      || !activeDebugText.includes('开启 4G 增强')
      || !activeDebugText.includes('停止电池保养')
      || !activeDebugText.includes('SMOKE-IMEI-001')
      || !activeDebugText.includes('RTK 一键标定')
      || !activeDebugText.includes('格式化机场')
    ) {
      errors.push(`commands: remote debug controls did not follow current device state (${JSON.stringify(activeDebugText)})`)
    }
    if (
      activeQuickDebugText.includes('打开舱盖\n')
      || activeQuickDebugText.includes('飞机开机\n')
      || activeQuickDebugText.includes('开启充电\n')
    ) {
      errors.push(`commands: remote debug controls showed both sides of a state toggle (${JSON.stringify(activeQuickDebugText)})`)
    }
  }
  if (await window.locator('.debug-operation-result').count()) {
    errors.push('commands: legacy bottom result bar is still visible')
  }
  await inspectLayout('remote-debug', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.command-center',
    '.remote-debug-console',
    '.debug-mode-gate',
    '.debug-operation-section',
    '.debug-operation-grid',
    '.debug-operation-card',
    '.debug-calibration-form',
  ])
  await window.screenshot({ path: `${screenshotBase}-commands-debug-active.png` })
  await window.locator('.debug-calibration-form').scrollIntoViewIfNeeded()
  await window.screenshot({ path: `${screenshotBase}-commands-debug-maintenance.png` })

  await window.getByRole('button', { name: '相机与云台', exact: true }).click()
  await window.locator('.camera-console').waitFor({ state: 'visible' })
  const cameraConsoleText = await window.locator('.camera-console').innerText()
  for (const expected of ['AIR-SMOKE-001', 'DOCK-SMOKE-001']) {
    if (!cameraConsoleText.includes(expected)) errors.push(`cameras: missing ${expected}`)
  }
  if (!await window.getByRole('button', { name: '播放', exact: true }).count()) {
    errors.push('cameras: missing playback control')
  }
  if (await window.locator('.camera-console-header, .camera-device-status').count()) {
    errors.push('cameras: removed summary or device-status element is still visible')
  }
  if (await window.locator('.camera-console-result').count()) {
    errors.push('cameras: legacy bottom result bar is still visible')
  }
  await inspectLayout('camera-center', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.command-center',
    '.camera-console',
    '.camera-console-layout',
    '.camera-player',
    '.camera-stream-toolbar',
  ])
  await window.screenshot({ path: `${screenshotBase}-commands-cameras.png` })

  await window.getByRole('button', { name: '飞行控制', exact: true }).click()
  await window.locator('.flight-authority-console').waitFor({ state: 'visible' })
  const lockedFlightText = await window.locator('.flight-authority-console').innerText()
  if (!lockedFlightText.includes('未获取控制权') || !lockedFlightText.includes('请先获取飞行控制权')) {
    errors.push(`commands: flight operations were not locked before DRC authority (${JSON.stringify(lockedFlightText)})`)
  }
  if (await window.locator('.command-tile:not([disabled])').count()) {
    errors.push('commands: flight commands remained enabled before DRC authority')
  }
  await window.screenshot({ path: `${screenshotBase}-commands-flight-locked.png` })

  if (profileId) {
    const flightAuthorityPayload = JSON.stringify({ data: { drc_state: 2 } })
    await electronApp.evaluate(({ BrowserWindow }, event) => {
      for (const instance of BrowserWindow.getAllWindows()) {
        instance.webContents.send('runtime:event', event)
      }
    }, {
      type: 'message',
      profileId,
      message: {
        id: 'smoke-dock2-flight-authority',
        profileId,
        direction: 'in',
        topic: 'thing/product/DOCK-SMOKE-001/state',
        payload: flightAuthorityPayload,
        qos: 1,
        retain: false,
        timestamp: Date.now(),
        size: Buffer.byteLength(flightAuthorityPayload),
      },
    })
    await window.locator('.flight-authority-console.active').waitFor({ state: 'visible' })
    const activeFlightText = await window.locator('.flight-authority-console').innerText()
    if (!activeFlightText.includes('已获取控制权') || !activeFlightText.includes('释放飞行控制权')) {
      errors.push(`commands: flight authority state did not unlock correctly (${JSON.stringify(activeFlightText)})`)
    }
    if (await window.locator('.command-tile:not([disabled])').count() !== 4) {
      errors.push('commands: flight commands did not unlock after DRC authority')
    }
  }
  await inspectLayout('flight-control', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.command-center',
    '.flight-authority-console',
    '.command-layout',
  ])
  await window.screenshot({ path: `${screenshotBase}-commands-flight-active.png` })

  if (await window.getByRole('button', { name: '视频直播', exact: true }).count()) {
    errors.push('commands: separate live category remained after merging it into camera controls')
  }

  await browserWindow.evaluate((instance) => instance.setContentSize(1024, 680))
  await window.waitForFunction(
    () => window.innerWidth === 1024 && window.innerHeight === 680,
    undefined,
    { timeout: 5_000 },
  )

  await window.getByRole('button', { name: '遥测项管理' }).click()
  await window.locator('.telemetry-manager').waitFor({ state: 'visible' })
  await window.locator('.telemetry-field-editor-form').waitFor({ state: 'visible' })
  await inspectLayout('telemetry-manager', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.telemetry-manager',
    '.telemetry-manager-layout',
    '.telemetry-manager-hierarchy',
    '.telemetry-manager-fields',
    '.telemetry-field-editor',
  ])
  await window.screenshot({ path: `${screenshotBase}-telemetry-manager.png` })

  await window.getByRole('button', { name: '媒体中心' }).click()
  await window.locator('.media-center').waitFor({ state: 'visible' })
  await inspectLayout('media', [
    'body',
    '.app-shell',
    '.workspace-content',
    '.media-center',
    '.media-server-panel',
    '.media-service-workspace',
  ])
  await window.getByRole('button', { name: '启动服务' }).click()
  await window.locator('.media-service-header .server-state-dot.running').waitFor({ state: 'visible', timeout: 15_000 })
  const localMediaRuntime = await window.evaluate(async () => {
    const servers = await window.djiApi.media.listServers()
    return window.djiApi.media.checkServer(servers.find((server) => server.kind === 'local-zlm').id)
  })
  if (!localMediaRuntime.ok || localMediaRuntime.runtime?.state !== 'running') {
    errors.push(`media: local ZLMediaKit did not become healthy (${localMediaRuntime.error ?? 'unknown error'})`)
  }
  await window.screenshot({ path: `${screenshotBase}-media.png` })
  await window.getByRole('button', { name: '停止服务' }).click()

  await window.getByRole('button', { name: '设备工作台' }).click()
  await window.locator('.overview-view').waitFor({ state: 'visible' })

  const snapshot = await window.evaluate(() => ({
    title: document.title,
    apiAvailable: typeof window.djiApi === 'object',
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyHeight: document.body.scrollHeight,
    viewportHeight: window.innerHeight,
  }))

  if (snapshot.bodyWidth > snapshot.viewportWidth || snapshot.bodyHeight > snapshot.viewportHeight) {
    errors.push(`Root overflow: ${snapshot.bodyWidth}x${snapshot.bodyHeight} in ${snapshot.viewportWidth}x${snapshot.viewportHeight}`)
  }

  process.stdout.write(`${JSON.stringify({ screenshotBase, snapshot, layouts, errors }, null, 2)}\n`)
  if (errors.length) process.exitCode = 1
} finally {
  await electronApp.close()
}
