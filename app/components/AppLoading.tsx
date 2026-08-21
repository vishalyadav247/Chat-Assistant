import { useEffect, useState } from "react";
import { useLocation, useNavigation } from "react-router";

// ChatConvert loading screen (design: .claude/resources/other/loading.html).
// Two jobs, one visual:
//
//   boot — the server HTML is painted but React has not hydrated yet, so the
//          page LOOKS ready while nothing is clickable. The overlay covers that
//          window and fades out on mount. Opaque, because the app really is
//          still opening.
//
//   nav  — a page change is in flight. Same mark on a frosted veil so the
//          screen you came from stays visible; it should never read as the app
//          restarting.
//
// Deliberately NOT shown for same-path loading: the inbox changes ?c= on every
// conversation click and revalidations fire constantly, and taking the screen
// over for those would be worse than showing nothing.

/** Minimum time the boot overlay stays up, so a fast open reads as a brand
 *  moment rather than a flicker. Hydration usually outlasts it anyway. */
const BOOT_MIN_MS = 400;
/** How long a navigation must be in flight before the overlay appears — short
 *  hops finish under this and never flash. */
const NAV_DELAY_MS = 300;
/** Keep in step with the .ccload--leaving transition in app-loading.css. */
const FADE_MS = 260;

function LoadingMark(props: { label: string }) {
  return (
    <div className="ccload__inner">
      <div className="ccload__logoWrap" aria-hidden="true">
        <span className="ccload__ring" />
        <span className="ccload__ring ccload__ring--2" />
        <span className="ccload__ring ccload__ring--3" />
        <div className="ccload__logo">C</div>
        <div className="ccload__orbit">
          <div className="ccload__pin">
            <svg viewBox="0 0 24 24">
              <path d="M4 5h16v10H9l-4 4V5z" />
              <path d="M8.5 9.5h7M8.5 12h4" />
            </svg>
          </div>
        </div>
      </div>

      <div className="ccload__name">ChatConvert</div>
      <div className="ccload__tag">AI shopping assistant — answers that convert</div>

      <div className="ccload__bar" role="progressbar" aria-label="Loading progress">
        <span />
      </div>
      <div className="ccload__status" role="status" aria-live="polite">
        {props.label}
        <span className="ccload__dot" />
        <span className="ccload__dot" />
        <span className="ccload__dot" />
      </div>
    </div>
  );
}

export function AppLoading() {
  const navigation = useNavigation();
  const location = useLocation();

  // "boot" on the server AND on the client's first render, so the markup
  // matches and hydration stays clean; the effect below is what ends it.
  const [boot, setBoot] = useState<"visible" | "leaving" | "done">("visible");
  const [navVisible, setNavVisible] = useState(false);

  useEffect(() => {
    const toLeaving = setTimeout(() => setBoot("leaving"), BOOT_MIN_MS);
    const toDone = setTimeout(() => setBoot("done"), BOOT_MIN_MS + FADE_MS);
    return () => {
      clearTimeout(toLeaving);
      clearTimeout(toDone);
    };
  }, []);

  const changingPage =
    navigation.state === "loading" &&
    !!navigation.location &&
    navigation.location.pathname !== location.pathname;

  useEffect(() => {
    if (!changingPage) {
      setNavVisible(false);
      return;
    }
    const timer = setTimeout(() => setNavVisible(true), NAV_DELAY_MS);
    return () => clearTimeout(timer);
  }, [changingPage]);

  if (boot !== "done") {
    return (
      <div
        className={`ccload ccload--boot${boot === "leaving" ? " ccload--leaving" : ""}`}
        // Nothing underneath is interactive yet, but keep it out of the a11y
        // tree the moment it starts leaving so focus never lands here.
        aria-hidden={boot === "leaving" ? true : undefined}
      >
        <LoadingMark label="Starting ChatConvert" />
      </div>
    );
  }

  if (!navVisible) return null;

  return (
    <div className="ccload ccload--nav">
      <LoadingMark label="Loading your screen" />
    </div>
  );
}
