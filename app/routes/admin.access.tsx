import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { AdminShell } from "../components/admin/AdminShell";
import { AdminCard, AdminPage } from "../components/admin/AdminUi";
import { ConfirmDeleteModal } from "../components/ui/ConfirmDeleteModal";
import { useAppBridge } from "../lib/ui/surface";
import {
  changeAdminPassword,
  createAdmin,
  listAdmins,
  removeAdmin,
  requireAdminUser,
  revokeAdminSessions,
  rootAdminEmail,
} from "../lib/admin/admin-auth.server";
import { sameOrigin } from "../lib/team/same-origin.server";

// Admin → Access (spec 19). Two kinds of operator, and the page says which is
// which: the .env pair (root — password lives in ADMIN_PASSWORD, cannot be
// removed or changed here) and accounts created on this page, which sign in
// with a stored password like any normal login.

const ADD_MODAL = "admin-add-user";
const PASSWORD_MODAL = "admin-change-password";

interface ModalElement extends HTMLElement {
  showOverlay: () => void;
  hideOverlay: () => void;
}
const modalEl = (id: string) => document.getElementById(id) as ModalElement | null;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requireAdminUser(request);
  const admins = await listAdmins();
  return {
    adminEmail: session.admin.email,
    selfId: session.admin.id,
    selfIsRoot: admins.find((a) => a.id === session.admin.id)?.isRoot ?? false,
    rootEmail: rootAdminEmail(),
    admins,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const session = await requireAdminUser(request);
  if (!sameOrigin(request))
    return { ok: false as const, error: "Request blocked. Reload the page and try again.", intent: "" };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const result = await createAdmin(
      String(form.get("name") ?? ""),
      String(form.get("email") ?? ""),
      String(form.get("password") ?? ""),
    );
    return { ...result, error: result.ok ? null : result.error, intent };
  }

  if (intent === "remove") {
    const result = await removeAdmin(String(form.get("adminId") ?? ""), session.admin.id);
    return { ...result, error: result.ok ? null : result.error, intent };
  }

  if (intent === "password") {
    const result = await changeAdminPassword(
      session.admin.id,
      String(form.get("current") ?? ""),
      String(form.get("next") ?? ""),
    );
    // Keep this browser signed in, drop the others: a password change should
    // end every session that was opened with the old one.
    if (result.ok) await revokeAdminSessions(session.admin.id, session.sessionId);
    return { ...result, error: result.ok ? null : result.error, intent };
  }

  if (intent === "revoke") {
    await revokeAdminSessions(session.admin.id, session.sessionId);
    return { ok: true as const, error: null, intent };
  }

  return { ok: false as const, error: "Unknown action.", intent };
};

const SUCCESS_MESSAGE: Record<string, string> = {
  add: "Admin added",
  remove: "Admin removed",
  password: "Password updated — your other sessions were signed out",
  revoke: "Other sessions signed out",
};

export default function AdminAccess() {
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

  const self = data.admins.find((a) => a.id === data.selfId);
  const otherSessions = Math.max(0, (self?.sessions ?? 1) - 1);

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
    <AdminShell adminEmail={data.adminEmail}>
      <AdminPage
        heading="Access"
        subheading="Who can sign in to this console."
        actions={
          // Polaris, like every other action button in the console (user,
          // 2026-09-03) — the console owns its chrome, not its controls.
          <s-button variant="primary" onClick={() => modalEl(ADD_MODAL)?.showOverlay()}>
            Add admin
          </s-button>
        }
      >
        <AdminCard heading="Operators" bodyClassName="cca-card__body--flush">
          <div className="cca-tablewrap">
            <table className="cca-table">
              <thead>
                <tr>
                  <th>Admin</th>
                  <th>Added</th>
                  <th className="cca-num">Sessions</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {data.admins.map((admin) => (
                  <tr key={admin.id}>
                    <td>
                      <div className="cca-person">
                        <span className="cca-avatar" aria-hidden>
                          {admin.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="cca-person__text">
                          <span className="cca-person__name">
                            {admin.name}
                            {admin.id === data.selfId ? <span className="cca-tag">You</span> : null}
                            {admin.isRoot ? (
                              <span className="cca-tag cca-tag--root" title="Set by ADMIN_EMAIL / ADMIN_PASSWORD">
                                .env
                              </span>
                            ) : null}
                          </span>
                          <span className="cca-person__meta">{admin.email}</span>
                        </span>
                      </div>
                    </td>
                    <td>{admin.createdAt}</td>
                    <td className="cca-num">{admin.sessions}</td>
                    <td className="cca-rowactions">
                      {admin.id === data.selfId && !admin.isRoot ? (
                        <s-button
                          variant="tertiary"
                          onClick={() => modalEl(PASSWORD_MODAL)?.showOverlay()}
                        >
                          Change password
                        </s-button>
                      ) : null}
                      {admin.isRoot || admin.id === data.selfId ? null : (
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          disabled={busy}
                          onClick={() => setRemoving({ id: admin.id, name: admin.name })}
                        >
                          Remove
                        </s-button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>

        <AdminCard heading="The .env admin">
          <p className="cca-prose">
            <strong>{data.rootEmail || "not configured"}</strong> signs in with{" "}
            <code>ADMIN_EMAIL</code> / <code>ADMIN_PASSWORD</code> from this server&rsquo;s{" "}
            <code>.env</code>. Change either value there and restart the app: the new pair works
            immediately and anyone still signed in with the old one is signed out on their next
            request. It can&rsquo;t be removed or edited here, and every other account on this page
            keeps working when it changes. Dev and production read their own <code>.env</code>.
          </p>
        </AdminCard>

        <AdminCard heading="Your sessions">
          <p className="cca-prose">
            {otherSessions === 0
              ? "This browser is the only one signed in as you."
              : `${otherSessions} other browser${otherSessions === 1 ? " is" : "s are"} signed in as you.`}
          </p>
          <div className="cca-actions">
            <s-button
              tone="critical"
              disabled={busy || otherSessions === 0}
              onClick={() => fetcher.submit({ intent: "revoke" }, { method: "post" })}
            >
              Sign out other sessions
            </s-button>
          </div>
        </AdminCard>
      </AdminPage>

      <s-modal id={ADD_MODAL} heading="Add admin">
        <s-stack gap="base">
          <s-text color="subdued">
            They get full access to this console immediately, and sign in with the password you set
            here.
          </s-text>
          <s-text-field label="Name" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
          <s-email-field label="Email" value={newEmail} onInput={(e) => setNewEmail(e.currentTarget.value)} />
          <s-password-field
            label="Password"
            details="At least 8 characters. Share it securely — they can change it after signing in."
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
        body="They lose access to the admin console immediately, and every session they have open ends. This can't be undone."
        confirmLabel="Remove admin"
        loading={busy}
        onConfirm={() => fetcher.submit({ intent: "remove", adminId: removing?.id ?? "" }, { method: "post" })}
        onCancel={() => setRemoving(null)}
      />
    </AdminShell>
  );
}
