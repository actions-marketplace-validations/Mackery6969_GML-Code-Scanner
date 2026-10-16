/**
 * Known GameMaker dependencies and where their releases are published. Each entry says how
 * to recognise the dependency in a project (extension name, version macro or generated
 * script) and where to look for newer versions. Projects can add their own entries in
 * `.gmlscan.json` under `dependencies.sources`.
 */

export type DependencySource =
  | { type: "github"; repo: string }
  | { type: "codeberg"; repo: string }
  /** A GameMaker Marketplace asset id (marketplace.gamemaker.io/assets/<id>). */
  | { type: "marketplace"; id: number };

export interface DependencySpec {
  /** Display name. */
  name: string;
  /** Extension resource names (case-insensitive). */
  extensions?: string[];
  /**
   * Functions the extension defines. When given, an extension only matches if it defines at
   * least one of them, so a project's own extension that happens to share the name isn't
   * mistaken for this one.
   */
  functions?: string[];
  /** Version macro stems: "SCRIBBLE" matches `#macro SCRIBBLE_VERSION "9.7.3"` and `__SCRIBBLE_VERSION`. */
  macros?: string[];
  /** Script resource whose header says when it was generated (GMLive's `// Generated at ...`). */
  generatedScript?: string;
  source: DependencySource;
  /** Where older releases are, for projects that moved (e.g. from GitHub to Codeberg). */
  previousSources?: DependencySource[];
  /**
   * Regular expression for the release asset that holds the package (default: any .yymps).
   * A capture group, if present, is the package's version, for repositories that publish
   * several packages per release with their own versions.
   */
  asset?: string;
  /** False when update pull requests must not replace this extension (default true). */
  autoUpdate?: boolean;
  /** Where to read about the dependency, when it isn't the source repository. */
  homepage?: string;
}

const yoyo = (name: string, repo: string, extension: string, functions?: string[], asset?: string): DependencySpec => ({
  name,
  extensions: [extension],
  functions,
  source: { type: "github", repo: `YoYoGames/GMEXT-${repo}` },
  ...(asset ? { asset } : {}),
});

/** One package per Firebase product, all in GMEXT-Firebase releases; the asset name carries each version. */
const firebase = (product: string, extension: string, assetName: string, functions: string[]): DependencySpec =>
  yoyo(`Firebase ${product}`, "Firebase", extension, functions, `^Firebase\\.${assetName}\\.(?:Ext\\.)?v(\\d+(?:\\.\\d+)+)\\.yymps$`);

/**
 * YoYo Games' official extensions (github.com/YoYoGames/GMEXT-*). Extension names and
 * fingerprint functions come from each repository's metadata.json and extension .yy.
 * Extensions with generic names and no stable fingerprint (Elements, Medal, MobileUtils,
 * Reddit, Twitch, mod.io) are left out rather than risk matching a project's own extension.
 */
const OFFICIAL_EXTENSIONS: DependencySpec[] = [
  yoyo("AdMob", "AdMob", "GMAdMob", ["admob_banner_set_ad_unit", "admob_banner_get_width"]),
  yoyo("App Tracking Transparency", "AppTrackingTransparency", "ext_AppTrackingTransparency", ["AppTrackingTransparency_available", "AppTrackingTransparency_request"]),
  yoyo("Apple IAP", "AppleIAP", "AppleIAP", ["iap_Init", "iap_QueryProducts"]),
  yoyo("Apple Sign In", "AppleSignIn", "AppleSignIn", ["AppleSignIn_Init", "AppleSignIn_AuthoriseUser"]),
  yoyo("Bluetooth", "Bluetooth", "Bluetooth", ["bt_init", "bt_classic_scan_start"]),
  yoyo("CrazyGames", "CrazyGames", "crazygames", ["crazy_game_gameplay_start", "crazy_game_loading_start"]),
  yoyo("Declared Age Range", "DeclaredAgeRange", "GMDeclaredAgeRange", ["declared_age_range_is_supported"]),
  yoyo("Discord Social SDK", "Discord", "GMDiscordSocial", ["discord_social_run_callbacks", "discord_social_shutdown"]),
  yoyo("Epic Online Services", "EpicOnlineServices", "EpicOnlineServices", ["eos_api_last_error", "eos_test"]),
  yoyo("Facebook", "Facebook", "GMFacebook", ["fb_ready", "fb_is_logged_in"]),
  firebase("Analytics", "YYFirebaseAnalytics", "Analytics", ["FirebaseAnalytics_LogEvent", "FirebaseAnalytics_SetAnalyticsCollectionEnabled"]),
  firebase("App Check", "YYFirebaseAppCheck", "App\\.Check", ["FirebaseAppCheck_GetToken", "FirebaseAppCheck_LimitedUseToken"]),
  firebase("Authentication", "YYFirebaseAuthentication", "Authentication", ["SDKFirebaseAuthentication_SignInWithCustomToken", "SDKFirebaseAuthentication_SignIn_Email"]),
  firebase("Cloud Functions", "YYFirebaseCloudFunctions", "(?:Cloud\\.)?Functions", ["SDKFirebaseCloudFunctions_Call", "SDKFirebaseCloudFunctions_Init"]),
  firebase("Cloud Messaging", "YYFirebaseCloudMessaging", "(?:Cloud\\.)?Messaging", ["FirebaseCloudMessaging_GetToken", "FirebaseCloudMessaging_SubscribeToTopic"]),
  firebase("Cloud Storage", "YYFirebaseStorage", "(?:Cloud\\.)?Storage", ["SDKFirebaseStorage_Download", "SDKFirebaseStorage_Upload"]),
  firebase("Crashlytics", "YYFirebaseCrashlytics", "Crashlytics", ["FirebaseCrashlytics_Log", "FirebaseCrashlytics_SetCustomKey"]),
  firebase("Firestore", "YYFirebaseFirestore", "Firestore", ["FirebaseFirestore_SDK"]),
  firebase("Performance", "YYFirebasePerformance", "Performance", ["FirebasePerformance_setPerformanceCollectionEnabled", "FirebasePerformance_isPerformanceCollectionEnabled"]),
  firebase("Realtime Database", "YYFirebaseRealTime", "Realtime(?:\\.Database)?", ["FirebaseRealTime_SDK"]),
  firebase("Remote Config", "YYFirebaseRemoteConfig", "Remote\\.Config", ["FirebaseRemoteConfig_Initialize", "FirebaseRemoteConfig_FetchAndActivate"]),
  yoyo("FMOD", "FMOD", "FMOD", ["fmod_channel_set_frequency", "fmod_channel_get_frequency"]),
  yoyo("Game Center", "GameCenter", "GMGameCenter", ["gamecenter_present_view_achievement", "gamecenter_local_player_is_authenticated"]),
  yoyo("Game Jolt", "GameJolt", "GameJolt", ["GameJolt_Dummy"]),
  yoyo("Microsoft GDK", "GDK", "GDKExtension", ["gdk_init", "gdk_update"]),
  yoyo("GOG Galaxy", "GOG", "gog", ["GOG_ProcessData", "GOG_GetError"]),
  yoyo("Google Play Billing", "GooglePlayBilling", "GMGooglePlayBilling", ["play_billing_end_connection", "play_billing_is_ready"]),
  yoyo("Google Play Instant", "GooglePlayInstant", "GooglePlayInstant", ["googleplayinstant_is_instant_app"]),
  yoyo("Google Play Integrity", "GooglePlayIntegrity", "GMPlayIntegrity"),
  yoyo("Google Play Licensing", "GooglePlayLicensing", "GooglePlayLicensingExtension", ["GooglePlayLicensing_CheckLicensing"]),
  yoyo("Google Play Pass Licensing", "GooglePlayPassLicensing", "GooglePlayPassLicensing", ["GooglePlayPassLicensing_CheckLicense"]),
  yoyo("Google Play Services", "GooglePlayServices", "GMGooglePlayServices", ["play_services_is_available"]),
  yoyo("Google Sign-In", "GoogleSignIn", "GoogleSignIn", ["GoogleSignIn_Show", "GoogleSignIn_SignOut"]),
  yoyo("H5 Games Ads", "H5GamesAds", "h5gamesads", ["H5GamesAds_Interstitial", "H5GamesAds_RewardVideo"]),
  yoyo("Huawei Paid Apps", "HuaweiPaidApps", "HuaweiPaidApps", ["huawei_paid_apps_check"]),
  yoyo("In-App Updates", "InAppUpdate", "InAppUpdates", ["inappupdate_request_info", "inappupdate_show"]),
  yoyo("Interhaptics", "Interhaptics-Main", "Interhaptics", ["interhaptics_init", "interhaptics_quit"]),
  yoyo("ironSource", "IronSource", "IronSource", ["ironsource_init", "ironsource_banner_create"]),
  yoyo("LevelPlay", "LevelPlay", "GMLevelPlay", ["levelplay_is_initialized", "levelplay_set_consent"]),
  yoyo("ML Kit", "MLKit", "GMMLKit", ["mlkit_translation_create", "mlkit_translation_close"]),
  yoyo("Mobile Review", "MobileReview", "GMMobileReview"),
  yoyo("Opera Ads", "OperaAds", "GMOperaAds", ["opera_ads_is_initialized", "opera_ads_set_mute"]),
  yoyo("Photon", "Photon", "GMPhoton", ["photon_realtime_init", "photon_realtime_shutdown"]),
  yoyo("Play Age Signals", "PlayAgeSignals", "PlayAgeSignals", ["play_age_signals_init", "play_age_signals_is_available"]),
  yoyo("Steamworks", "Steamworks", "Steamworks", ["steam_initialised", "steam_get_app_id", "steam_activate_overlay", "steam_stats_ready"]),
  yoyo("WebView", "WebView", "WebView", ["webview_show", "webview_hide"]),
];

/** Libraries copied into a project's scripts, recognised by their version macro. */
const LIBRARIES: DependencySpec[] = [
  { name: "Scribble", macros: ["SCRIBBLE"], source: { type: "github", repo: "JujuAdams/Scribble" } },
  { name: "SNAP", macros: ["SNAP"], source: { type: "github", repo: "JujuAdams/SNAP" } },
  { name: "Chatterbox", macros: ["CHATTERBOX"], source: { type: "github", repo: "JujuAdams/Chatterbox" } },
  { name: "Vinyl", macros: ["VINYL"], source: { type: "github", repo: "JujuAdams/Vinyl" } },
  { name: "Bulb", macros: ["BULB"], source: { type: "github", repo: "JujuAdams/Bulb" } },
  { name: "Dynamo", macros: ["DYNAMO"], source: { type: "github", repo: "JujuAdams/Dynamo" } },
  { name: "Coroutines", macros: ["COROUTINES"], source: { type: "github", repo: "JujuAdams/Coroutines" } },
  { name: "iota", macros: ["IOTA"], source: { type: "github", repo: "JujuAdams/iota" } },
  { name: "Collage", macros: ["COLLAGE"], source: { type: "github", repo: "tabularelf/Collage" } },
  { name: "Input", macros: ["INPUT"], source: { type: "codeberg", repo: "offalynne/Input" }, previousSources: [{ type: "github", repo: "offalynne/Input" }] },
];

const OTHER: DependencySpec[] = [
  { name: "NekoPresence", extensions: ["NekoPresence"], functions: ["np_initdiscord", "np_setpresence", "np_clearpresence"], source: { type: "github", repo: "nkrapivin/NekoPresence" } },
  {
    name: "GMLive",
    generatedScript: "GMLive",
    source: { type: "marketplace", id: 5992 },
    homepage: "https://yellowafterlife.itch.io/gamemaker-live",
  },
];

export const BUILTIN_DEPENDENCIES: DependencySpec[] = [...OFFICIAL_EXTENSIONS, ...LIBRARIES, ...OTHER];

/** Human-readable source, e.g. "YoYoGames/GMEXT-Steamworks on GitHub". */
export function describeSource(source: DependencySource): string {
  switch (source.type) {
    case "github":
      return `${source.repo} on GitHub`;
    case "codeberg":
      return `${source.repo} on Codeberg`;
    case "marketplace":
      return "the GameMaker Marketplace";
  }
}

export function sourceUrl(source: DependencySource): string {
  switch (source.type) {
    case "github":
      return `https://github.com/${source.repo}`;
    case "codeberg":
      return `https://codeberg.org/${source.repo}`;
    case "marketplace":
      return `https://marketplace.gamemaker.io/assets/${source.id}`;
  }
}
