import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDefaultTelemetryLayout } from '../lib/telemetry-layout'
import { TelemetryManager, telemetryMetadataSourceLabel } from './TelemetryManager'

const renderManager = (config: ReturnType<typeof createDefaultTelemetryLayout>): string =>
  renderToStaticMarkup(
    <TelemetryManager config={config} onChange={() => undefined} onNotify={() => undefined} />,
  )

describe('TelemetryManager property metadata', () => {
  it('labels each metadata provider and fallback source', () => {
    expect(telemetryMetadataSourceLabel('superdock')).toContain('SuperDock 机场设备属性')
    expect(telemetryMetadataSourceLabel('dji-superdock')).toContain('DJI / SuperDock 同名字段')
    expect(telemetryMetadataSourceLabel('dji-superdock')).toContain('当前展示 DJI 默认定义')
    expect(telemetryMetadataSourceLabel('dji-dock2')).toContain('DJI Dock 2 设备属性')
    expect(telemetryMetadataSourceLabel('dji-dock2-dock3')).toContain('DJI Dock 2 / Dock 3 设备属性')
    expect(telemetryMetadataSourceLabel('dji-aircraft')).toContain('DJI 飞行器设备属性')
    expect(telemetryMetadataSourceLabel('custom')).toBe('遥测项管理 · 自定义属性设置')
    expect(telemetryMetadataSourceLabel('default')).toBe('未关联官方物模型元数据')
  })

  it('shows official permissions, type, constraints and source as managed metadata', () => {
    const config = createDefaultTelemetryLayout()
    const firstSection = config.devices.aircraft.tabs[0].sections[0]
    firstSection.fieldKeys = ['rth_altitude']

    const markup = renderManager(config)

    expect(markup).toContain('属性设置')
    expect(markup).toContain('可读写')
    expect(markup).toContain('<code>int</code>')
    expect(markup).toContain('&quot;max&quot;:500')
    expect(markup).toContain('DJI 飞行器设备属性')
    expect(markup).not.toContain('允许通过 property/set 设置')
  })

  it('renders editable property settings for a custom field', () => {
    const config = createDefaultTelemetryLayout()
    config.devices.aircraft.fields.push({
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
    config.devices.aircraft.tabs[0].sections[0].fieldKeys = ['custom_level']

    const markup = renderManager(config)

    expect(markup).toContain('允许通过 property/set 设置')
    expect(markup).toContain('value="custom_control.level"')
    expect(markup).toContain('<option value="enum_int" selected="">整数枚举</option>')
    expect(markup).toContain('遥测项管理 · 自定义属性设置')
    expect(markup).not.toContain('添加字段')
    expect(markup).not.toContain('删除字段')
  })
})
