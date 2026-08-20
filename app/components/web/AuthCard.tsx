import type { ReactNode } from "react";

// Centered branded card used by every /web/* auth page (spec 18).

export function AuthCard(props: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="ccwa-page">
      <div className="ccwa-card">
        <div className="ccwa-brand">
          <div className="ccwa-brandMark" aria-hidden="true">
            C
          </div>
          <span className="ccwa-brandName">ChatConvert</span>
        </div>
        <h1 className="ccwa-title">{props.title}</h1>
        {props.subtitle ? <p className="ccwa-subtitle">{props.subtitle}</p> : null}
        {props.children}
        {props.footer ? <div className="ccwa-footer">{props.footer}</div> : null}
      </div>
    </div>
  );
}

/** Class names for the auth pages (plain stylesheet, see web-auth.css). */
export const authStyles = {
  form: "ccwa-form",
  pick: "ccwa-pick",
  pickButton: "ccwa-pickButton",
  pickRole: "ccwa-pickRole",
} as const;
