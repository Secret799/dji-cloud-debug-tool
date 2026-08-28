import logoUrl from '../../../../build/logo.svg'

interface BrandLogoProps {
  className?: string
  label?: string
}

export function BrandLogo({ className, label }: BrandLogoProps) {
  return (
    <img
      className={className}
      src={logoUrl}
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      draggable={false}
    />
  )
}
