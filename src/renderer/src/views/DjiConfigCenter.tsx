import { useState } from 'react'
import { CircleAlert, ListTree } from 'lucide-react'
import type { DeviceProvider, TelemetryLayoutConfig } from '../../../shared/contracts'
import { ErrorCodeManager } from './ErrorCodeManager'
import { TelemetryManager } from './TelemetryManager'

type DjiConfigSection = 'telemetry' | 'errors'

interface DjiConfigCenterProps {
  config: TelemetryLayoutConfig
  onChange: (config: TelemetryLayoutConfig) => void
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void
}

export function DjiConfigCenter({ config, onChange, onNotify }: DjiConfigCenterProps) {
  const [activeSection, setActiveSection] = useState<DjiConfigSection>('telemetry')
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
        <button
          className={`dji-config-section-tab ${activeSection === 'telemetry' ? 'active' : ''}`}
          onClick={() => setActiveSection('telemetry')}
        >
          <ListTree size={15} />
          <span><strong>监测项管理</strong><small>页签、字段与属性设置</small></span>
        </button>
        <button
          className={`dji-config-section-tab ${activeSection === 'errors' ? 'active' : ''}`}
          onClick={() => setActiveSection('errors')}
        >
          <CircleAlert size={15} />
          <span>
            <strong>{provider === 'superdock' ? '错误项管理' : '错误码管理'}</strong>
            <small>{provider === 'superdock' ? '任务错误码、机场 HMS 与航线中断' : '上云错误码、HMS 与常见问题'}</small>
          </span>
        </button>
      </nav>

      <section className="dji-config-panel">
        {activeSection === 'telemetry' ? (
          <TelemetryManager key={provider} provider={provider} config={config} onChange={onChange} onNotify={onNotify} />
        ) : (
          <ErrorCodeManager key={provider} provider={provider} />
        )}
      </section>
    </div>
  )
}
