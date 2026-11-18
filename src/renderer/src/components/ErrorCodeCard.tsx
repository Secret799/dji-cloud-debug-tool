import { BookOpen, SquareArrowOutUpRight } from 'lucide-react'
import { findHmsErrorCode, lookupServiceError } from '../lib/dji-error-codes'

interface ErrorCodeCardProps {
  result: number | string
  onOpenTrace?: () => void
  onOpenErrorCode?: () => void
  className?: string
}

export function ErrorCodeCard({ result, onOpenTrace, onOpenErrorCode, className = '' }: ErrorCodeCardProps) {
  const guidance = typeof result === 'number'
    ? lookupServiceError(result)
    : (() => {
        const hms = findHmsErrorCode(result)
        return {
          hmsCode: hms?.code,
          message: hms?.message ?? hms?.faq ?? undefined,
          cause: hms?.cause ?? undefined,
          solution: hms?.solution ?? hms?.faq ?? undefined,
          logs: undefined,
        }
      })()

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
      {onOpenErrorCode && (
        <button type="button" className="error-code-card-link" onClick={onOpenErrorCode}>
          <BookOpen size={12} />在错误码中查看全部说明 <span aria-hidden="true">›</span>
        </button>
      )}
      {onOpenTrace && (
        <button type="button" className="error-code-card-link" onClick={onOpenTrace}>
          <SquareArrowOutUpRight size={12} />在报文中查看
        </button>
      )}
    </section>
  )
}
