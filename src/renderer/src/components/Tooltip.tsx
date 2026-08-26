import { cloneElement, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  label: string
  children: ReactElement<{ 'aria-label'?: string; title?: string }>
}

interface TooltipPosition {
  placement: 'top' | 'right' | 'bottom' | 'left'
  left: number
  top: number
}

export function Tooltip({ label, children }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  const show = (): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()

    if (rect.left < 88) {
      setPosition({ placement: 'right', left: rect.right + 8, top: rect.top + rect.height / 2 })
    } else if (rect.right > window.innerWidth - 88) {
      setPosition({ placement: 'left', left: rect.left - 8, top: rect.top + rect.height / 2 })
    } else if (rect.bottom + 44 <= window.innerHeight) {
      setPosition({ placement: 'bottom', left: rect.left + rect.width / 2, top: rect.bottom + 8 })
    } else {
      setPosition({ placement: 'top', left: rect.left + rect.width / 2, top: rect.top - 8 })
    }
  }

  const control = cloneElement(children, {
    'aria-label': children.props['aria-label'] ?? label,
    title: undefined,
  })

  return (
    <span
      className="tooltip-trigger"
      ref={triggerRef}
      onPointerEnter={show}
      onPointerLeave={() => setPosition(null)}
      onFocusCapture={show}
      onBlurCapture={() => setPosition(null)}
    >
      {control}
      {position && createPortal(
        <span
          className="tooltip-popup"
          data-placement={position.placement}
          role="tooltip"
          style={{ left: position.left, top: position.top }}
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  )
}
