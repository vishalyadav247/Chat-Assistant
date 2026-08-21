import nodemailer from "nodemailer";
import { runtimeConfig } from "../platform/runtime-config.server";
import { logError } from "../log.server";

// Transactional email seam (spec 18 / spec 10 & 17 "email provider decision").
// Provider + credentials are operator-managed at /platform/settings, falling
// back to the EMAIL_* environment variables (spec 19). Modes:
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
  const e = runtimeConfig();
  if (e.emailProvider === "resend") return Boolean(e.resendApiKey);
  if (e.emailProvider === "smtp") return Boolean(e.smtpHost);
  return false;
}

// Cached per credential set so a settings change takes effect without a restart.
let transporter: { fingerprint: string; value: nodemailer.Transporter } | null = null;
function smtpTransport() {
  const e = runtimeConfig();
  const fingerprint = `${e.smtpHost}|${e.smtpPort}|${e.smtpSecure}|${e.smtpUser}|${e.smtpPass}`;
  if (!transporter || transporter.fingerprint !== fingerprint) {
    transporter = {
      fingerprint,
      value: nodemailer.createTransport({
        host: e.smtpHost,
        port: e.smtpPort,
        secure: e.smtpSecure,
        auth: e.smtpUser ? { user: e.smtpUser, pass: e.smtpPass } : undefined,
      }),
    };
  }
  return transporter.value;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const e = runtimeConfig();
  if (e.emailProvider === "resend" && e.resendApiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${e.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: e.emailFrom,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logError("email_send_failed", `Resend ${res.status}`, { status: res.status, response: body.slice(0, 300) });
        return { delivered: false, provider: "resend", error: `Resend ${res.status}` };
      }
      return { delivered: true, provider: "resend" };
    } catch (error) {
      logError("email_send_error", error);
      return { delivered: false, provider: "resend", error: "network" };
    }
  }
  if (e.emailProvider === "smtp" && e.smtpHost) {
    try {
      await smtpTransport().sendMail({
        from: e.emailFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { delivered: true, provider: "smtp" };
    } catch (error) {
      logError("email_smtp_error", error instanceof Error ? error.message : error);
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

// Shared branded shell (matches BRAND in app/components/ui/tokens.ts:
// accent #6d3bf5, gradient #6d3bf5→#3b82f6). Inline styles only — email
// clients strip <style> blocks. Every template returns html + text so the
// smtp/log providers work unchanged.
function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px"><tr><td style="border-radius:10px;background:linear-gradient(135deg,#6d3bf5,#3b82f6)">
         <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px">${escapeHtml(cta.label)}</a>
       </td></tr></table>
       <p style="color:#78787f;font-size:12px;line-height:1.6;margin:12px 0 0">If the button doesn't work, copy this link into your browser:<br>
       <a href="${escapeHtml(cta.url)}" style="color:#6d3bf5;word-break:break-all">${escapeHtml(cta.url)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f7;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2e2e37">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e9e9ec">
      <tr><td style="background:linear-gradient(135deg,#6d3bf5,#3b82f6);padding:18px 32px">
        <span style="color:#ffffff;font-weight:700;font-size:17px;letter-spacing:.2px">ChatConvert</span>
      </td></tr>
      <tr><td style="padding:32px">
        <h1 style="font-size:20px;line-height:1.35;margin:0 0 14px;color:#1f1f26">${escapeHtml(title)}</h1>
        <div style="font-size:14px;line-height:1.65;color:#4a4a53">${bodyHtml}</div>
        ${button}
      </td></tr>
      <tr><td style="padding:18px 32px;border-top:1px solid #f1f1f1">
        <p style="margin:0;color:#a2a2ab;font-size:12px;line-height:1.6">You're receiving this because of activity on a ChatConvert workspace. If you weren't expecting this email, you can safely ignore it.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

export function inviteEmail(args: { to: string; inviterName: string; shopName: string; url: string }): EmailMessage {
  const subject = `${args.inviterName} invited you to ${args.shopName} on ChatConvert`;
  const text = `${args.inviterName} invited you to join the ${args.shopName} team on ChatConvert.

As a team member you'll answer shopper conversations, hand-picked by AI when a human is needed.

Accept the invitation and set your password:
${args.url}

This link expires in 7 days. If you weren't expecting this invitation, you can ignore this email.`;
  const html = layout(
    `${escapeHtml(args.inviterName)} invited you to join ${escapeHtml(args.shopName)}`,
    `<p style="margin:0 0 12px"><strong>${escapeHtml(args.inviterName)}</strong> invited you to join the <strong>${escapeHtml(args.shopName)}</strong> team on ChatConvert — the AI support &amp; sales chat for their store.</p>
     <p style="margin:0 0 12px">You'll pick up shopper conversations whenever the AI hands over to a human, right from a shared team inbox.</p>
     <p style="margin:0;color:#78787f">The invitation expires in <strong>7 days</strong>.</p>`,
    { label: "Accept invitation", url: args.url },
  );
  return { to: args.to, subject, html, text };
}

export function resetEmail(args: { to: string; url: string }): EmailMessage {
  const subject = "Reset your ChatConvert password";
  const text = `Someone requested a password reset for your ChatConvert login.

Set a new password:
${args.url}

This link expires in 1 hour and can be used once. If you didn't request this, you can ignore this email — your password stays unchanged.`;
  const html = layout(
    "Reset your password",
    `<p style="margin:0 0 12px">Someone requested a password reset for your ChatConvert login.</p>
     <p style="margin:0;color:#78787f">The link expires in <strong>1 hour</strong> and can be used once. If this wasn't you, ignore this email — your password stays unchanged.</p>`,
    { label: "Set a new password", url: args.url },
  );
  return { to: args.to, subject, html, text };
}

export function handoverEmail(args: { to: string; shopName: string; url: string; snippet?: string }): EmailMessage {
  const subject = `A shopper needs a human — ${args.shopName}`;
  const snippet = args.snippet ? `\n\n"${args.snippet}"` : "";
  const text = `A conversation on ${args.shopName} was handed over to your team.${snippet}

Open it in the inbox:
${args.url}`;
  const html = layout(
    "A shopper needs a human",
    `<p style="margin:0 0 12px">A conversation on <strong>${escapeHtml(args.shopName)}</strong> was handed over to your team.</p>${
      args.snippet
        ? `<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #6d3bf5;background:#efeafe;border-radius:0 8px 8px 0;color:#4a4a53">${escapeHtml(args.snippet)}</blockquote>`
        : ""
    }<p style="margin:0;color:#78787f">Reply from the shared inbox so the shopper isn't kept waiting.</p>`,
    { label: "Open in inbox", url: args.url },
  );
  return { to: args.to, subject, html, text };
}
