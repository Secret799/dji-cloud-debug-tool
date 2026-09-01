import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDefaultTelemetryLayout } from '../lib/telemetry-layout'
import {
  buildTelemetryAutoFormatSuggestions,
  TelemetryManager,
  telemetryMetadataSourceLabel,
} from './TelemetryManager'

const renderManager = (
  config: ReturnType<typeof createDefaultTelemetryLayout>,
  provider: 'dji' | 'superdock' = 'dji',
): string =>
  renderToStaticMarkup(
    <TelemetryManager provider={provider} config={config} onChange={() => undefined} onNotify={() => undefined} />,
  )

describe('TelemetryManager property metadata', () => {
  it('labels each metadata provider and fallback source', () => {
    expect(telemetryMetadataSourceLabel('superdock')).toContain('SuperDock 机场设备属性')
    expect(telemetryMetadataSourceLabel('dji-superdock')).toContain('DJI / SuperDock 同名字段')
    expect(telemetryMetadataSourceLabel('dji-superdock')).toContain('当前展示 DJI 默认定义')
    expect(telemetryMetadataSourceLabel('dji-dock2')).toContain('DJI Dock 2 设备属性')
    expect(telemetryMetadataSourceLabel('dji-dock2-dock3')).toContain('DJI Dock 2 / Dock 3 设备属性')
    expect(telemetryMetadataSourceLabel('dji-aircraft')).toContain('DJI 飞行器设备属性')
    expect(telemetryMetadataSourceLabel('custom')).toBe('监测项管理 · 自定义属性设置')
    expect(telemetryMetadataSourceLabel('default')).toBe('未关联官方物模型元数据')
  })

  it('shows official permissions, type, constraints and source as managed metadata', () => {
    const config = createDefaultTelemetryLayout()
    const firstSection = config.devices.dock.tabs[0].sections[0]
    firstSection.fieldKeys = ['silent_mode']

    const markup = renderManager(config)

    expect(markup).toContain('属性设置')
    expect(markup).toContain('可读写')
    expect(markup).toContain('<code>enum_int</code>')
    expect(markup).toContain('&quot;1&quot;:&quot;静音模式&quot;')
    expect(markup).toContain('DJI Dock 2 / Dock 3 设备属性')
    expect(markup).not.toContain('允许通过 property/set 设置')
  })

  it('renders editable property settings for a custom field', () => {
    const config = createDefaultTelemetryLayout()
    config.devices.dock.fields.push({
      key: 'custom_level',
      label: '自定义等级',
      description: '',
      visible: true,
      propertySetting: {
        enabled: true,
        path: 'custom_control.level',
        type: 'enum_int',
        constraint: '{"0":"关闭","1":"开启"}',
      },
    })
    config.devices.dock.tabs[0].sections[0].fieldKeys = ['custom_level']

    const markup = renderManager(config)

    expect(markup).toContain('允许通过 property/set 设置')
    expect(markup).toContain('value="custom_control.level"')
    expect(markup).toContain('<option value="enum_int" selected="">整数枚举</option>')
    expect(markup).toContain('监测项管理 · 自定义属性设置')
    expect(markup).not.toContain('添加字段')
    expect(markup).not.toContain('删除字段')
  })

  it('offers built-in data formatters and marks configured fields', () => {
    const config = createDefaultTelemetryLayout()
    const field = config.devices.dock.fields.find((item) => item.key === 'activation_time')
    if (!field) throw new Error('Missing activation time field')
    field.formatter = 'datetime'
    config.devices.dock.tabs[0].sections[0].fieldKeys = [field.key]

    const markup = renderManager(config)

    expect(markup).toContain('数据格式化')
    expect(markup).toContain('时间戳 -&gt; 日期时间')
    expect(markup).toContain('秒 -&gt; x 时 x 分 x 秒')
    expect(markup).toContain('米 -&gt; 千米')
    expect(markup).toContain('KB -&gt; MB')
    expect(markup).toContain('KB -&gt; GB')
    expect(markup).toContain('<option value="datetime" selected="">')
    expect(markup).toContain('已格式化')
    expect(markup).toContain('自动识别')
  })

  it('builds unit-aware suggestions across all DJI monitoring items', () => {
    const config = createDefaultTelemetryLayout()
    const activationTime = config.devices.dock.fields.find((field) => field.key === 'activation_time')
    if (!activationTime) throw new Error('Missing activation time field')
    activationTime.formatter = 'date'

    const suggestions = buildTelemetryAutoFormatSuggestions(config, 'dji')
    const suggestion = (device: 'dock' | 'aircraft', key: string) =>
      suggestions.find((item) => item.deviceType === device && item.fieldKey === key)

    expect(suggestion('dock', 'activation_time')).toMatchObject({
      formatter: 'datetime', currentFormatter: 'date', selected: false,
    })
    expect(suggestion('dock', 'acc_time')?.formatter).toBe('seconds_to_duration')
    expect(suggestion('dock', 'storage.total')).toMatchObject({
      formatter: 'kilobytes_to_megabytes',
      options: ['kilobytes_to_megabytes', 'kilobytes_to_gigabytes'],
    })
    expect(suggestion('aircraft', 'total_flight_distance')?.formatter).toBe('meters_to_kilometers')
    expect(suggestions.some((item) => item.fieldKey === 'network_state.rate')).toBe(false)
  })

  it('defaults to the dock and uses SuperDock metadata for the strawberry brand', () => {
    const config = createDefaultTelemetryLayout()
    config.devices.dock.tabs[0].sections[0].fieldKeys = ['air_transfer_enable']

    const markup = renderManager(config, 'superdock')

    expect(markup).toContain('>机场</button>')
    expect(markup).not.toContain('>飞机</button>')
    expect(markup).not.toContain('>遥控器</button>')
    expect(markup).toContain('空中回传（无人机到机场）')
    expect(markup).toContain('SuperDock 机场设备属性')
  })
})
