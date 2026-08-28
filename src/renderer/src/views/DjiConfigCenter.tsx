import { useState } from 'react'
import { CircleAlert, ListTree } from 'lucide-react'
import type { TelemetryLayoutConfig } from '../../../shared/contracts'
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

  return (
    <div className="dji-config-center">
      <nav className="dji-config-tabs" aria-label="大疆配置分类">
        <button
          className={activeSection === 'telemetry' ? 'active' : ''}
          onClick={() => setActiveSection('telemetry')}
        >
          <ListTree size={15} />
          <span><strong>遥测项管理</strong><small>页签、字段与属性设置</small></span>
        </button>
        <button
          className={activeSection === 'errors' ? 'active' : ''}
          onClick={() => setActiveSection('errors')}
        >
          <CircleAlert size={15} />
          <span><strong>错误码管理</strong><small>上云错误码、HMS 与常见问题</small></span>
        </button>
      </nav>

      <section className="dji-config-panel">
        {activeSection === 'telemetry' ? (
          <TelemetryManager config={config} onChange={onChange} onNotify={onNotify} />
        ) : (
          <ErrorCodeManager />
        )}
      </section>
    </div>
  )
}
