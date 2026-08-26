import { useEffect } from 'react'
import { ExternalLink, RadioTower, X } from 'lucide-react'
import packageMetadata from '../../../../package.json'
import { Tooltip } from './Tooltip'

interface AboutModalProps {
  onClose: () => void
}

export function AboutModal({ onClose }: AboutModalProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header className="modal-header">
          <div>
            <span className="eyebrow">ABOUT</span>
            <h2 id="about-title">关于</h2>
          </div>
          <Tooltip label="关闭">
            <button className="icon-button" onClick={onClose} autoFocus><X size={18} /></button>
          </Tooltip>
        </header>

        <div className="modal-body about-body">
          <div className="about-product">
            <span className="about-product-mark"><RadioTower size={26} /></span>
            <div>
              <h3>大疆云调试台</h3>
              <p>DJI Cloud Studio</p>
            </div>
          </div>

          <p className="about-description">
            一款面向 macOS 的大疆上云 API 与 MQTT 调试工具，提供多连接管理、设备遥测、DJI 指令调试和媒体流预览能力。
          </p>

          <dl className="about-details">
            <div><dt>版本</dt><dd>v{packageMetadata.version}</dd></div>
            <div>
              <dt>作者</dt>
              <dd>
                <a href={packageMetadata.author.url} target="_blank" rel="noreferrer">
                  {packageMetadata.author.name}<ExternalLink size={12} />
                </a>
              </dd>
            </div>
            <div><dt>许可证</dt><dd>{packageMetadata.license}</dd></div>
          </dl>

          <p className="about-notice">
            本项目不是 DJI 官方产品。连接真实设备前，请先在隔离环境中验证 Topic、参数和权限。
          </p>
        </div>

        <footer className="modal-footer about-footer">
          <span>为 DJI Cloud API 调试工作流而设计</span>
          <button className="button primary" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  )
}
