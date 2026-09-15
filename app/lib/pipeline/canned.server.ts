// Deterministic shopper-facing strings, localized (hardening spec 23 §3.9).
//
// The generated lanes follow languageInstruction() and answer in the persona's
// language — but every zero-generation path (clarify, fallback, cap, blocked,
// picks-only, the recommendation banner…) used to be an English constant, so a
// Hindi store's conversation flipped to English exactly on the deterministic
// turns. The persona language set is FIXED (the five codes in the spec-08
// select), so these are static translations: no LLM call, no cache, no drift —
// the zero-generation paths stay zero-generation.
//
// Scope: a fixed non-English default language (auto-detect OFF) serves its
// translation. Auto-detect ON keeps English — mirroring the shopper's latest
// message would need per-turn generation, which these paths must never do
// (documented limitation). Merchant-authored texts (guardrails fallback,
// humanModeMessage) always win over these defaults; only the built-in default
// is localized.
//
// NOT prompts: nothing here is ever sent to the model. LLM instructions live
// only in prompts.ts.

export interface PersonaLanguage {
  defaultLanguage?: string | null;
  autoDetectLanguage?: boolean | null;
}

export type CannedKey =
  | "clarify"
  | "fallback"
  | "fallbackNoForm"
  | "busy"
  | "orderStatus"
  | "blockedTopic"
  | "cap"
  | "humanWait"
  | "picksOnly"
  | "chatClosed"
  | "offTopic";

const STRINGS: Record<CannedKey, Record<string, string>> = {
  clarify: {
    en: "I couldn't find a match — what kind of item are you after?",
    hi: "मुझे कोई मेल नहीं मिला — आप किस तरह की चीज़ ढूंढ रहे हैं?",
    es: "No encontré nada que encaje — ¿qué tipo de artículo buscas?",
    fr: "Je n'ai pas trouvé de correspondance — quel type d'article cherchez-vous ?",
    de: "Ich habe leider nichts Passendes gefunden — wonach suchst du genau?",
  },
  fallback: {
    en: "I'm not sure about that one — leave your email and our team will get back to you.",
    hi: "इस बारे में मुझे पक्का पता नहीं — अपना ईमेल छोड़ दें, हमारी टीम आपसे संपर्क करेगी।",
    es: "No estoy seguro de eso — déjanos tu correo y nuestro equipo te responderá.",
    fr: "Je ne suis pas sûr de pouvoir répondre — laissez votre e-mail et notre équipe vous recontactera.",
    de: "Da bin ich mir nicht sicher — hinterlasse deine E-Mail und unser Team meldet sich bei dir.",
  },
  // For shops whose handover settings show no leave-message form: no promise
  // to collect an email the widget cannot take.
  fallbackNoForm: {
    en: "I'm not sure about that one — please reach out to our team and they'll be happy to help.",
    hi: "इस बारे में मुझे पक्का पता नहीं — कृपया हमारी टीम से संपर्क करें, वे खुशी से मदद करेंगे।",
    es: "No estoy seguro de eso — ponte en contacto con nuestro equipo y te ayudarán con gusto.",
    fr: "Je ne suis pas sûr de pouvoir répondre — contactez notre équipe, elle se fera un plaisir de vous aider.",
    de: "Da bin ich mir nicht sicher — wende dich gern an unser Team, es hilft dir weiter.",
  },
  busy: {
    en: "You're sending messages very quickly — give me a few seconds and try again.",
    hi: "आप बहुत तेज़ी से संदेश भेज रहे हैं — कुछ सेकंड रुककर फिर से कोशिश करें।",
    es: "Estás enviando mensajes muy rápido — espera unos segundos e inténtalo de nuevo.",
    fr: "Vous envoyez des messages très vite — patientez quelques secondes et réessayez.",
    de: "Du schreibst sehr schnell — warte ein paar Sekunden und versuch es noch einmal.",
  },
  orderStatus: {
    // "Track order" stays verbatim — it names the widget button.
    en: "You can check your order right here — tap Track order and enter your order number with the email or phone you used.",
    hi: "आप अपना ऑर्डर यहीं देख सकते हैं — Track order पर टैप करें और ऑर्डर नंबर के साथ वही ईमेल या फ़ोन दर्ज करें जो आपने इस्तेमाल किया था।",
    es: "Puedes consultar tu pedido aquí mismo — toca Track order e introduce tu número de pedido con el correo o teléfono que usaste.",
    fr: "Vous pouvez suivre votre commande ici — appuyez sur Track order et saisissez votre numéro de commande avec l'e-mail ou le téléphone utilisé.",
    de: "Du kannst deine Bestellung direkt hier prüfen — tippe auf Track order und gib deine Bestellnummer mit der verwendeten E-Mail oder Telefonnummer ein.",
  },
  blockedTopic: {
    en: "That's not something I can help with here — but I'm happy to help you find a product or answer questions about the store.",
    hi: "इसमें मैं यहां मदद नहीं कर सकता — लेकिन कोई प्रोडक्ट ढूंढने या स्टोर के बारे में सवालों में खुशी से मदद करूंगा।",
    es: "No puedo ayudarte con eso aquí — pero con gusto te ayudo a encontrar un producto o a resolver dudas sobre la tienda.",
    fr: "Je ne peux pas vous aider sur ce sujet — mais je serai ravi de vous aider à trouver un produit ou à répondre à vos questions sur la boutique.",
    de: "Dabei kann ich hier leider nicht helfen — aber ich helfe dir gern, ein Produkt zu finden oder Fragen zum Shop zu beantworten.",
  },
  // No contact promise in the text (QA2-A4): when the shop collects details,
  // the pipeline attaches the leave-message form under this message.
  cap: {
    en: "Our chat assistant is offline right now — please try again a little later.",
    hi: "हमारा चैट असिस्टेंट अभी ऑफ़लाइन है — कृपया थोड़ी देर बाद फिर से कोशिश करें।",
    es: "Nuestro asistente de chat está desconectado ahora — vuelve a intentarlo en un rato.",
    fr: "Notre assistant de chat est hors ligne pour le moment — veuillez réessayer un peu plus tard.",
    de: "Unser Chat-Assistent ist gerade offline — bitte versuch es etwas später noch einmal.",
  },
  humanWait: {
    en: "Thanks for reaching out! Our team is helping other customers right now — we'll connect you with an agent shortly.",
    hi: "संपर्क करने के लिए धन्यवाद! हमारी टीम अभी दूसरे ग्राहकों की मदद कर रही है — हम जल्द ही आपको एक एजेंट से जोड़ देंगे।",
    es: "¡Gracias por escribirnos! Nuestro equipo está atendiendo a otros clientes — en breve te conectaremos con un agente.",
    fr: "Merci de nous avoir contactés ! Notre équipe aide d'autres clients en ce moment — nous vous mettrons en relation avec un agent sous peu.",
    de: "Danke für deine Nachricht! Unser Team hilft gerade anderen Kunden — wir verbinden dich in Kürze mit einem Mitarbeiter.",
  },
  picksOnly: {
    en: "Here's what I found — tell me if you'd like more options.",
    hi: "यह रहा जो मुझे मिला — और विकल्प चाहिए तो बताइए।",
    es: "Esto es lo que encontré — dime si quieres más opciones.",
    fr: "Voici ce que j'ai trouvé — dites-moi si vous voulez d'autres options.",
    de: "Das habe ich gefunden — sag mir, wenn du mehr Optionen sehen möchtest.",
  },
  chatClosed: {
    en: "This chat has been closed by the store team.",
    hi: "यह चैट स्टोर टीम द्वारा बंद कर दी गई है।",
    es: "Este chat ha sido cerrado por el equipo de la tienda.",
    fr: "Cette conversation a été fermée par l'équipe de la boutique.",
    de: "Dieser Chat wurde vom Shop-Team geschlossen.",
  },
  offTopic: {
    en: "I can only help with our store's products and orders.",
    hi: "मैं केवल हमारे स्टोर के प्रोडक्ट और ऑर्डर में मदद कर सकता हूं।",
    es: "Solo puedo ayudarte con los productos y pedidos de nuestra tienda.",
    fr: "Je ne peux vous aider qu'avec les produits et commandes de notre boutique.",
    de: "Ich kann nur bei Produkten und Bestellungen unseres Shops helfen.",
  },
};

const RECOMMENDATION_BANNER: Record<string, (title: string) => string> = {
  en: (title) => `${title} — here are our picks:`,
  hi: (title) => `${title} — ये रहे हमारे सुझाव:`,
  es: (title) => `${title} — estas son nuestras recomendaciones:`,
  fr: (title) => `${title} — voici notre sélection :`,
  de: (title) => `${title} — hier ist unsere Auswahl:`,
};

function cannedLanguage(persona: PersonaLanguage | null | undefined): string {
  if (!persona || persona.autoDetectLanguage || !persona.defaultLanguage) return "en";
  return persona.defaultLanguage in RECOMMENDATION_BANNER ? persona.defaultLanguage : "en";
}

/** The deterministic string for this shop's fixed reply language. */
export function canned(key: CannedKey, persona: PersonaLanguage | null | undefined): string {
  const table = STRINGS[key];
  return table[cannedLanguage(persona)] ?? table.en;
}

/** "<rule title> — here are our picks:" in the shop's fixed reply language. */
export function recommendationBanner(
  title: string,
  persona: PersonaLanguage | null | undefined,
): string {
  return (RECOMMENDATION_BANNER[cannedLanguage(persona)] ?? RECOMMENDATION_BANNER.en)(title);
}
