import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { installDemoBrowserStorage } from "./browserStorage";

installDemoBrowserStorage();
window.localStorage.setItem(
  "t3code:client-settings:v1",
  JSON.stringify({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-10-28T00:00:00.000Z",
  }),
);

const { installDemoHttp, DEMO_ENVIRONMENT_ID, DEMO_THREAD_ID } = await import("./environment");
const demo = installDemoHttp();
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) demo[Symbol.dispose]();
});

// A refresh starts a new visit, so its route must belong to the restored fixtures.
window.history.replaceState(null, "", `#/${DEMO_ENVIRONMENT_ID}/${DEMO_THREAD_ID}`);

await import("../bootstrap");
