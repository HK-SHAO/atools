import type { ReactNode } from "react";

interface Props {
  label: string;
  className?: string;
  children: ReactNode;
}

export function Fold({ label, className, children }: Props) {
  return (
    <details className={className ? `fold ${className}` : "fold"}>
      <summary>
        {label}
        <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      {children}
    </details>
  );
}
