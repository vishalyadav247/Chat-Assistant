import nodemailer from "nodemailer";
import { env } from "../env.server";

// Transactional email seam (spec 18 / spec 10 & 17 "email provider decision").
// Provider is picked from EMAIL_PROVIDER:
//   log    — prints the message; returns delivered=false so callers fall back
//            to copy-link UX (dev default).
//   resend — POST https://api.resend.com/emails (plain fetch, no SDK).
//   smtp   — nodemailer over SMTP_HOST/PORT/USER/PASS (Gmail app password,
//            SES, Mailgun SMTP, …) — handy for dev and self-hosters.
// Never throws: a mail outage must not break invites/handovers.

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailResult {
  delivered: boolean;
  provider: "log" | "resend" | "smtp";
  error?: string;
}

export function emailConfigured(): boolean {
  const e = env();
  if (e.EMAIL_PROVIDER === "resend") return Boolean(e.RESEND_API_KEY);
  if (e.EMAIL_PROVIDER === "smtp") return Boolean(e.SMTP_HOST);
  return false;
}

let transporter: nodemailer.Transporter | null = null;
function smtpTransport() {
  if (!transporter) {
    const e = env();
    transporter = nodemailer.createTransport({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const e = env();
  if (e.EMAIL_PROVIDER === "resend" && e.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${e.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: e.EMAIL_FROM,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("email_send_failed", res.status, body.slice(0, 300));
        return { delivered: false, provider: "resend", error: `Resend ${res.status}` };
      }
      return { delivered: true, provider: "resend" };
    } catch (error) {
      console.error("email_send_error", error);
      return { delivered: false, provider: "resend", error: "network" };
    }
  }
  if (e.EMAIL_PROVIDER === "smtp" && e.SMTP_HOST) {
    try {
      await smtpTransport().sendMail({
        from: e.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { delivered: true, provider: "smtp" };
    } catch (error) {
      console.error("email_smtp_error", error instanceof Error ? error.message : error);
      return { delivered: false, provider: "smtp", error: "smtp" };
    }
  }
  console.log(`[email:log] to=${message.to} subject="${message.subject}"\n${message.text}`);
  return { delivered: false, provider: "log" };
}

// ── Templates ────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#303030;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(cta.label)}</a></p>
       <p style="color:#6b7280;font-size:12px">Or copy this link: <br><span style="word-break:break-all">${escapeHtml(cta.url)}</span></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f6f6f7;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">
  <div style="max-width:520px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
    <div style="font-weight:700;font-size:16px;margin-bottom:16px">ChatConvert</div>
    <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
    ${bodyHtml}
    ${button}
    <p style="color:#9ca3af;font-size:12px;margin-top:28px">If you weren't expecting this email you can ignore it.</p>
  </div></body></html>`;
}

export function inviteEmail(args: { to: string; inviterName: string; shopName: string; url: string }): EmailMessage {
  const subject = `${args.inviterName} invited you to ${args.shopName} on ChatConvert`;
  const text = `${args.inviterName} invited you to help with customer conversations for ${args.shopName} on ChatConvert.\n\nAccept the invitation and set your password:\n${args.url}\n\nThe link expires in 7 days.`;
  const html = layout(
    `You're invited to ${args.shopName}`,
    `<p>${escapeHtml(args.inviterName)} invited you to help with customer conversations for <strong>${escapeHtml(args.shopName)}</strong> on ChatConvert.</p><p>Accept the invitation and set your password. The link expires in 7 days.</p>`,
    { label: "Accept invitation", url: args.url },
  );
  return { to: args.to, subject, html, text };
}

export function resetEmail(args: { to: string; url: string }): EmailMessage {
  const subject = "Reset your ChatConvert password";
  const text = `Someone requested a password reset for your ChatConvert login.\n\nSet a new password:\n${args.url}\n\nThe link expires in 1 hour.`;
  const html = layout(
    "Reset your password",
    `<p>Someone requested a password reset for your ChatConvert login. The link expires in 1 hour.</p>`,
    { label: "Set a new password", url: args.url },
  );
  return { to: args.to, subject, html, text };
}

export function handoverEmail(args: { to: string; shopName: string; url: string; snippet?: string }): EmailMessage {
  const subject = `A shopper needs a human — ${args.shopName}`;
  const snippet = args.snippet ? `\n\n"${args.snippet}"` : "";
  const text = `A conversation on ${args.shopName} was handed over to your team.${snippet}\n\nOpen it in the inbox:\n${args.url}`;
  const html = layout(
    "A shopper needs a human",
    `<p>A conversation on <strong>${escapeHtml(args.shopName)}</strong> was handed over to your team.</p>${
      args.snippet ? `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #e5e7eb;color:#4b5563">${escapeHtml(args.snippet)}</blockquote>` : ""
    }`,
    { label: "Open in inbox", url: args.url },
  );
  return { to: args.to, subject, html, text };
}
