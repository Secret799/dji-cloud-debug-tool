import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DjiDevice } from '../../../shared/contracts'
import { DeviceModal } from './DeviceModal'

const renderDeviceModal = (device: DjiDevice, isNew = false): string => renderToStaticMarkup(
  <DeviceModal
    device={device}
    isNew={isNew}
    gatewayDevices={[]}
    onClose={vi.fn()}
    onSave={vi.fn()}
    onRemove={vi.fn()}
  />,
)

describe('DeviceModal provider models', () => {
  it('only offers gateway types when adding a new device', () => {
    const markup = renderDeviceModal({
      id: 'new',
      name: '新机场',
      sn: '',
      type: 'dock',
      provider: 'dji',
      dockModel: 'dock2',
    }, true)

    expect(markup).toContain('<h2>添加网关</h2>')
    expect(markup).toContain('<button type="button" class="active">机场</button>')
    expect(markup).toContain('<button type="button" class="">遥控器</button>')
    expect(markup).not.toContain('>飞机</button>')
    expect(markup).toContain('保存网关</button>')
  })

  it('keeps the aircraft type available when editing an existing aircraft', () => {
    const markup = renderDeviceModal({
      id: 'aircraft',
      name: '已发现飞机',
      sn: 'AIR-1',
      type: 'aircraft',
      provider: 'dji',
    })

    expect(markup).toContain('<button type="button" class="active">飞机</button>')
  })

  it('labels the pilot device type as a remote controller', () => {
    const markup = renderDeviceModal({
      id: 'pilot',
      name: '新遥控器',
      sn: 'RC-1',
      type: 'pilot',
      provider: 'dji',
    })

    expect(markup).toContain('<button type="button" class="active">遥控器</button>')
    expect(markup).toContain('value="新遥控器"')
  })

  it('renders DJI airport models for a DJI dock', () => {
    const markup = renderDeviceModal({
      id: 'dock',
      name: 'DJI Dock 3',
      sn: 'DJI-DOCK-1',
      type: 'dock',
      provider: 'dji',
      dockModel: 'dock3',
    })

    expect(markup).toContain('<button type="button" class="active">DJI</button>')
    expect(markup).toContain('<option value="dock3" selected="">DJI Dock 3</option>')
    expect(markup).not.toContain('SuperDock S24M4')
  })

  it('renders SuperDock models for a Strawberry airport', () => {
    const markup = renderDeviceModal({
      id: 'superdock',
      name: 'SuperDock S24M4',
      sn: 'SB-DOCK-1',
      type: 'dock',
      provider: 'superdock',
      dockModel: 's24m4',
    })

    expect(markup).toContain('<button type="button" class="active">草莓机场</button>')
    expect(markup).toContain('<option value="s24m4" selected="">SuperDock S24M4</option>')
    expect(markup).not.toContain('DJI Dock 3</option>')
  })
})
