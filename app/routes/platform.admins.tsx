import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import db from "../db.server";
import { PlatformShell } from "../components/platform/PlatformShell";
import { ConfirmDeleteModal } from "../components/ui/ConfirmDeleteModal";
import { useAppBridge } from "../lib/ui/surface";
import {
  requirePlatformAdmin,
  revokeAdminSessions,
} from "../lib/platform/platform-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/team/password.server";

// Platform → Admins (spec 19): manage operator accounts. Safeguards: can't
// remove yourself, can't remove the last admin.
// UI (user, 2026-08-20): the page is just the list + a right-aligned "Add New" button;
// adding and password changes happen in modals, feedback comes back as toasts.

const ADD_MODAL = "platform-add-admin";
const PASSWORD_MODAL = "platform-change-password";

interface ModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const modalEl = (id: string) => document.getElementById(id) as ModalElement | null;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  const admins = await db.platformAdmin.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  return {
    adminEmail: session.admin.email,
    selfId: session.admin.id,
    admins: admins.map((a) => ({ ...a, createdAt: a.createdAt.toISOString().slice(0, 10) })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const session = await requirePlatformAdmin(request);
  if (!sameOrigin(request))
    return { ok: false as const, error: "Request blocked. Reload the page and try again.", intent: "" };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    if (!name || !email.includes("@"))
      return { ok: false as const, error: "Name and a valid email are required.", intent };
    const problem = passwordProblem(password);
    if (problem) return { ok: false as const, error: problem, intent };
    const existing = await db.platformAdmin.findUnique({ where: { email } });
    if (existing) return { ok: false as const, error: "An admin with that email already exists.", intent };
    await db.platformAdmin.create({ data: { name, email, passwordHash: await hashPassword(password) } });
    return { ok: true as const, error: null, intent };
  }

  if (intent === "remove") {
    const adminId = String(form.get("adminId") ?? "");
    if (adminId === session.admin.id)
      return { ok: false as const, error: "You can't remove your own account.", intent };
    // Transaction so two concurrent removes can't drop below one admin.
    const removed = await db.$transaction(async (tx) => {
      const count = await tx.platformAdmin.count();
      if (count <= 1) return false;
      await tx.platformAdmin.delete({ where: { id: adminId } }).catch(() => undefined);
      return true;
    });
    if (!removed) return { ok: false as const, error: "At least one admin must remain.", intent };
    return { ok: true as const, error: null, intent };
  }

  if (intent === "password") {
    const current = String(form.get("current") ?? "");
    const next = String(form.get("next") ?? "");
    const problem = passwordProblem(next);
    if (problem) return { ok: false as const, error: problem, intent };
    const me = await db.platformAdmin.findUnique({ where: { id: session.admin.id } });
    if (!me || !(await verifyPassword(current, me.passwordHash))) {
      return { ok: false as const, error: "Current password is incorrect.", intent };
    }
    await db.platformAdmin.update({
      where: { id: me.id },
      data: { passwordHash: await hashPassword(next) },
    });
    await revokeAdminSessions(me.id, session.sessionId); // keep this browser signed in
    return { ok: true as const, error: null, intent };
  }

  return { ok: false as const, error: "Unknown action.", intent };
};

const SUCCESS_MESSAGE: Record<string, string> = {
  add: "Admin added",
  remove: "Admin removed",
  password: "Password updated — your other sessions were signed out",
};

export default function PlatformAdmins() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [currentPw, setCurrentPw] = useState("");
  const [nextPw, setNextPw] = useState("");
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  // Toast the result once per completed submission, and close the modal that
  // produced it (matches the admin/web surfaces — no banner at the top).
  const handled = useRef<unknown>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      shopify.toast.show(SUCCESS_MESSAGE[result.intent] ?? "Saved");
      if (result.intent === "add") {
        modalEl(ADD_MODAL)?.hideOverlay();
        setNewName("");
        setNewEmail("");
        setNewPassword("");
      }
      if (result.intent === "password") {
        modalEl(PASSWORD_MODAL)?.hideOverlay();
        setCurrentPw("");
        setNextPw("");
      }
      if (result.intent === "remove") setRemoving(null);
    } else if (result.error) {
      shopify.toast.show(result.error, { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  return (
    <PlatformShell adminEmail={data.adminEmail}>
      <s-page heading="Admins">
        <s-stack gap="base">
          <s-text color="subdued">
            Operator accounts with full access to this console. Every admin can change global settings for all stores.
          </s-text>

          <s-section heading="Accounts">
            <s-stack gap="base">
              <s-stack direction="inline" gap="base" justifyContent="end">
                <s-button variant="primary" onClick={() => modalEl(ADD_MODAL)?.showOverlay()}>
                  Add New
                </s-button>
              </s-stack>

              <s-table>
                <s-table-header-row>
                  <s-table-header>Admin</s-table-header>
                  <s-table-header>Added</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.admins.map((admin) => (
                    <s-table-row key={admin.id}>
                      <s-table-cell>
                        <s-stack gap="small-300">
                          <s-stack direction="inline" gap="small-300">
                            <s-text type="strong">{admin.name}</s-text>
                            {admin.id === data.selfId ? <s-badge tone="info">You</s-badge> : null}
                          </s-stack>
                          <s-text color="subdued">{admin.email}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{admin.createdAt}</s-table-cell>
                      <s-table-cell>
                        {admin.id === data.selfId ? (
                          <s-button
                            icon="edit"
                            variant="tertiary"
                            accessibilityLabel="Change my password"
                            onClick={() => modalEl(PASSWORD_MODAL)?.showOverlay()}
                          />
                        ) : (
                          <s-button
                            icon="delete"
                            tone="critical"
                            variant="tertiary"
                            accessibilityLabel={`Remove ${admin.name}`}
                            disabled={busy || data.admins.length <= 1}
                            onClick={() => setRemoving({ id: admin.id, name: admin.name })}
                          />
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-stack>
          </s-section>
        </s-stack>
      </s-page>

      <s-modal id={ADD_MODAL} heading="Add new admin">
        <s-stack gap="base">
          <s-text color="subdued">The new admin gets full access to this console immediately.</s-text>
          <s-text-field label="Name" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
          <s-email-field label="Email" value={newEmail} onInput={(e) => setNewEmail(e.currentTarget.value)} />
          <s-password-field
            label="Password"
            details="At least 8 characters. Share it with them securely — they can change it after signing in."
            value={newPassword}
            onInput={(e) => setNewPassword(e.currentTarget.value)}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={busy}
          disabled={!newName.trim() || !newEmail.includes("@") || newPassword.length < 8}
          onClick={() =>
            fetcher.submit(
              { intent: "add", name: newName, email: newEmail, password: newPassword },
              { method: "post" },
            )
          }
        >
          Add admin
        </s-button>
        <s-button slot="secondary-actions" onClick={() => modalEl(ADD_MODAL)?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>

      <s-modal id={PASSWORD_MODAL} heading="Change my password">
        <s-stack gap="base">
          <s-text color="subdued">Your other sessions are signed out; this browser stays signed in.</s-text>
          <s-password-field
            label="Current password"
            value={currentPw}
            onInput={(e) => setCurrentPw(e.currentTarget.value)}
          />
          <s-password-field
            label="New password"
            details="At least 8 characters."
            value={nextPw}
            onInput={(e) => setNextPw(e.currentTarget.value)}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={busy}
          disabled={!currentPw || nextPw.length < 8}
          onClick={() => fetcher.submit({ intent: "password", current: currentPw, next: nextPw }, { method: "post" })}
        >
          Update password
        </s-button>
        <s-button slot="secondary-actions" onClick={() => modalEl(PASSWORD_MODAL)?.hideOverlay()}>
          Cancel
        </s-button>
      </s-modal>

      <ConfirmDeleteModal
        open={removing !== null}
        title={`Remove ${removing?.name ?? "this admin"}?`}
        body="They lose access to the platform console immediately. This can't be undone."
        confirmLabel="Remove admin"
        loading={busy}
        onConfirm={() => fetcher.submit({ intent: "remove", adminId: removing?.id ?? "" }, { method: "post" })}
        onCancel={() => setRemoving(null)}
      />
    </PlatformShell>
  );
}
