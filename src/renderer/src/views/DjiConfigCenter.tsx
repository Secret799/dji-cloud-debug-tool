import { useState } from 'react'
import { ListTree } from 'lucide-react'
import type { DeviceProvider, TelemetryLayoutConfig } from '../../../shared/contracts'
import { TelemetryManager } from './TelemetryManager'

interface DjiConfigCenterProps {
  config: TelemetryLayoutConfig
  onChange: (config: TelemetryLayoutConfig) => void
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void
}

export function DjiConfigCenter({ config, onChange, onNotify }: DjiConfigCenterProps) {
  const [provider, setProvider] = useState<DeviceProvider>('dji')

  const selectProvider = (nextProvider: DeviceProvider): void => {
    setProvider(nextProvider)
  }

  return (
    <div className="dji-config-center">
      <nav className="dji-config-tabs" aria-label="监测项配置分类">
        <div className="segmented monitoring-brand-segmented" role="group" aria-label="设备品牌">
          <button type="button" className={provider === 'dji' ? 'active' : ''} onClick={() => selectProvider('dji')}>大疆</button>
          <button type="button" className={provider === 'superdock' ? 'active' : ''} onClick={() => selectProvider('superdock')}>草莓</button>
        </div>
        <span className="dji-config-tabs-divider" />
        <div className="dji-config-section-tab active">
          <ListTree size={15} />
          <span><strong>监测项管理</strong><small>页签、字段与属性设置</small></span>
        </div>
      </nav>

      <section className="dji-config-panel">
        <TelemetryManager key={provider} provider={provider} config={config} onChange={onChange} onNotify={onNotify} />
      </section>
    </div>
  )
}
