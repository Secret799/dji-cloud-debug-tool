import { SquareArrowOutUpRight } from 'lucide-react'
import { lookupServiceError } from '../lib/dji-error-codes'

interface ErrorCodeCardProps {
  result: number
  onOpenTrace?: () => void
  className?: string
}

export function ErrorCodeCard({ result, onOpenTrace, className = '' }: ErrorCodeCardProps) {
  const guidance = lookupServiceError(result)

  return (
    <section className={`error-code-card ${className}`.trim()}>
      <header>
        <strong>错误码 {result}</strong>
        {guidance.hmsCode && <code>{guidance.hmsCode}</code>}
      </header>
      <p>{guidance.message ?? '错误码库暂未收录该错误的详细说明。'}</p>
      {guidance.cause && <small>可能原因：{guidance.cause}</small>}
      {guidance.solution && <small>处理措施：{guidance.solution}</small>}
      {guidance.logs && <small>建议日志：{guidance.logs}</small>}
      {onOpenTrace && (
        <button type="button" className="error-code-card-link" onClick={onOpenTrace}>
          <SquareArrowOutUpRight size={12} />在报文中查看
        </button>
      )}
    </section>
  )
}
