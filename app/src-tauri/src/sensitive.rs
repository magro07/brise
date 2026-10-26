//! „Achtung, sensible Daten“: Prüfung eines Prompts und seiner Anhänge, bevor
//! sie an ein Modell ohne Zero Data Retention gehen.
//!
//! Zweistufig: Ein lokaler Vorfilter (Muster und Prüfsummen, ohne Netz) sucht
//! Kennzeichen wie E-Mail, IBAN, Steuer-ID, Telefonnummern, Schlüssel und
//! Begriffe aus Gesundheit, Berufsgeheimnis oder EU-AI-Act-Praktiken. Nur bei
//! einem Treffer fragt Brise ein Cortecs-Decision-Modell (`predicate`, mit
//! ZDR) nach Wahrscheinlichkeiten. Ans Modell gehen der Prompt und nur kurze
//! Ausschnitte rund um die Treffer in Anhängen – nie die ganzen Dateien.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};

type CmdResult<T> = Result<T, String>;

/// Kategorien: Kennung, Anzeigename, Frage an das Decision-Modell.
pub const CATEGORIES: &[(&str, &str, &str)] = &[
    (
        "personal",
        "Personenbezogene Daten (DSGVO)",
        "Does the text contain personal data of a real, identifiable person, e.g. a name together with contact details, address, date of birth, customer or ID numbers? Obvious placeholders, examples, test fixtures and public figures in a public role do not count.",
    ),
    (
        "special",
        "Besondere Kategorien (Art. 9 DSGVO)",
        "Does the text reveal data about a real person's health, genetic or biometric data, racial or ethnic origin, political opinions, religious beliefs, trade union membership, sex life or sexual orientation (GDPR Art. 9)?",
    ),
    (
        "secret",
        "Geschäfts- und Unternehmensgeheimnisse",
        "Does the text contain non-public business secrets, e.g. internal financial figures, strategy, pricing, customer lists, contracts, unreleased product plans or material marked confidential? Ordinary source code of a project does not count by itself.",
    ),
    (
        "credentials",
        "Zugangsdaten",
        "Does the text contain real credentials such as passwords, API keys, access tokens or private keys? Placeholders, environment variable names and dummy values do not count.",
    ),
    (
        "secrecy203",
        "Berufsgeheimnis (§ 203 StGB)",
        "Does the text contain information entrusted to a professional bound by secrecy, e.g. patient data of doctors or therapists, client data of lawyers, tax advisors, auditors, social workers or insurers (German § 203 StGB)?",
    ),
    (
        "aiact",
        "EU AI Act: verboten oder Hochrisiko",
        "Is the purpose of the request a practice that the EU AI Act prohibits (social scoring, manipulation, emotion recognition at work or school, untargeted facial scraping, biometric categorisation by sensitive traits, predictive policing of individuals) or classifies as high-risk (recruitment and candidate ranking, worker management, credit scoring, insurance pricing, education grading, access to public services, law enforcement, migration, critical infrastructure, biometric identification)?",
    ),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// Was gefunden wurde, z. B. „IBAN“.
    pub label: String,
    /// Maskierter Ausschnitt – nie der volle Wert.
    pub sample: String,
    /// Fundstelle: „Prompt“ oder Dateiname.
    pub source: String,
    /// Eindeutig (Prüfsumme, Schlüsselformat) statt nur verdächtig.
    pub strong: bool,
    #[serde(skip)]
    context: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: &'static str,
    pub label: &'static str,
    /// Wahrscheinlichkeit 0–1; vom Decision-Modell oder lokal geschätzt.
    pub probability: f64,
    pub hits: Vec<Hit>,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub flagged: bool,
    pub categories: Vec<Category>,
    /// Zusammenfassung für den Hinweis über dem Composer.
    pub reason: String,
    /// "local" (nur Vorfilter) oder "cortecs" (Decision-Modell mit ZDR).
    pub checked_by: &'static str,
    pub model: Option<String>,
    pub ms: u64,
    pub cost_eur: f64,
    /// Anhänge, die Brise nicht lokal lesen kann (PDF, Bilder).
    pub unreadable: Vec<String>,
    pub error: Option<String>,
}

const THRESHOLD: f64 = 0.5;

struct Rule {
    category: &'static str,
    label: &'static str,
    re: Regex,
    strong: bool,
    check: Option<fn(&str) -> bool>,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let r = |category, label, pattern: &str, strong, check: Option<fn(&str) -> bool>| Rule { category, label, re: Regex::new(pattern).expect("gültiges Muster"), strong, check };
        vec![
            // Zugangsdaten
            r("credentials", "Privater Schlüssel", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----", true, None),
            r("credentials", "AWS-Zugangsschlüssel", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", true, None),
            r("credentials", "GitHub-Token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})\b", true, None),
            r("credentials", "Slack-Token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}", true, None),
            r("credentials", "API-Schlüssel (sk-…)", r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}", true, None),
            r("credentials", "Google-API-Schlüssel", r"\bAIza[0-9A-Za-z_-]{35}\b", true, None),
            r("credentials", "JWT", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", true, None),
            r("credentials", "Verbindungs-URL mit Passwort", r"\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@]+:[^\s:/@]{4,}@[^\s/]+", true, Some(not_placeholder_url)),
            r(
                "credentials",
                "Passwort/Token im Klartext",
                r#"(?i)\b(?:password|passwort|kennwort|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"',;]{8,})"#,
                false,
                Some(not_placeholder_secret),
            ),
            // Personenbezug
            r("personal", "E-Mail-Adresse", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", false, Some(real_email)),
            r("personal", "IBAN", r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b", true, Some(valid_iban)),
            r("personal", "Steuer-ID", r"\b[1-9]\d{10}\b", false, Some(valid_tax_id)),
            r("personal", "Telefonnummer", r"(?:(?:\+|00)(?:49|43|41)[\s/-]?\(?0?\)?[1-9][\d\s/-]{6,14}\d|(?i:tel(?:efon)?|mobil|handy|fon)\.?:?\s*\+?[\d][\d\s/()-]{6,16}\d)", false, None),
            r("personal", "Geburtsdatum", r"(?i)\b(?:geb(?:oren)?\.?\s*(?:am)?|geburtsdatum|date of birth|dob)\s*:?\s*\d{1,2}\.\s?\d{1,2}\.\s?(?:19|20)\d{2}", false, None),
            r("personal", "Anschrift", r"\b[A-ZÄÖÜ][a-zäöüß-]+(?:straße|strasse|str\.|weg|allee|platz|gasse|ring)\s+\d{1,4}[a-z]?\s*,?\s*\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+", false, None),
            r("personal", "Ausweis-/Versicherungsnummer", r"(?i)\b(?:sozialversicherungs|rentenversicherungs|krankenversicherten|personalausweis|reisepass|steuer)-?(?:nummer|nr\.?)\b", false, None),
            r("personal", "Personenangabe", r"\b(?:Herr|Frau|Hr\.|Fr\.)\s+(?:Dr\.\s+)?[A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?", false, None),
            r("personal", "Gehalt/Personalakte", r"(?i)\b(?:gehalt|gehälter|lohnabrechnung|personalakte|abmahnung|kündigung von|bewerbungsunterlagen|lebenslauf)\b", false, None),
            // Art. 9 DSGVO
            r(
                "special",
                "Gesundheitsangabe",
                r"(?i)\b(?:diagnose|befund|erkrank\w*|krankheit\w*|krankschreibung|arbeitsunfähig\w*|hiv|aids|krebs|tumor|depression\w*|psychotherap\w*|psychiatr\w*|schwanger\w*|behinderung|schwerbehindert\w*|medikation|medikament\w*|therapie|icd-10|suchterkrank\w*|allergie)\b",
                false,
                None,
            ),
            r(
                "special",
                "Weltanschauung/Herkunft/Orientierung",
                r"(?i)\b(?:religion|konfession|religionszugehörigkeit|gewerkschaftsmitglied\w*|parteimitglied\w*|politische (?:einstellung|meinung)|ethnische herkunft|sexuelle orientierung|homosexuell\w*|transgender|biometrisch\w*|genetisch\w*|fingerabdr\w*|vorstrafe\w*)\b",
                false,
                None,
            ),
            // Geschäftsgeheimnisse
            r(
                "secret",
                "Vertraulichkeitsvermerk",
                r"(?i)\b(?:streng vertraulich|vertraulich|confidential|geschäftsgeheimnis\w*|betriebsgeheimnis\w*|nur für den internen gebrauch|internal use only|nda|verschwiegenheitsvereinbarung|nicht zur weitergabe)\b",
                false,
                None,
            ),
            r(
                "secret",
                "Interne Geschäftszahlen",
                r"(?i)\b(?:umsatzplanung|umsatzzahlen|quartalszahlen|ebitda|marge[n]?|preiskalkulation|kundenliste|kundendaten|lieferantenkonditionen|übernahmepläne|m&a|due diligence|businessplan|roadmap intern)\b",
                false,
                None,
            ),
            // § 203 StGB
            r(
                "secrecy203",
                "Berufsgeheimnis",
                r"(?i)\b(?:mandant\w*|patient\w*|klient\w*|krankenakte|patientenakte|schweigepflicht|steuerberat\w*|anwaltskanzlei|rechtsanwält\w*|wirtschaftsprüf\w*|arztbrief|sozialdaten)\b",
                false,
                None,
            ),
            // EU AI Act
            r(
                "aiact",
                "Verbotene Praxis (Art. 5)",
                r"(?i)\b(?:social scoring|sozialkredit\w*|emotionserkennung|emotion recognition|gesichtserkennung|face recognition|biometrische (?:identifizierung|kategorisierung|fernidentifizierung)|predictive policing|verhaltensmanipulation|lügendetektor)\b",
                false,
                None,
            ),
            r(
                "aiact",
                "Hochrisiko-Einsatz (Anhang III)",
                r"(?i)(?:bewerber\w*\s+(?:\w+\s+){0,3}(?:auswähl|auswahl|filter|rank|bewert|sortier|aussortier)\w*|(?:candidate|applicant)s?\s+(?:\w+\s+){0,2}(?:screening|ranking|scoring)|kreditwürdigkeit|bonitätsprüfung|credit scor\w*|mitarbeiterüberwachung|leistungsüberwachung von mitarbeitenden|prüfungsbewertung|noten automatisch|versicherungsprämie\w* (?:nach|anhand)|sozialleistungen (?:prüf|entscheid)\w*)",
                false,
                None,
            ),
        ]
    })
}

fn not_placeholder_secret(m: &str) -> bool {
    let v = m.rsplit(['=', ':']).next().unwrap_or(m).trim().trim_matches(['"', '\'']).to_lowercase();
    let placeholders = ["xxx", "***", "changeme", "password", "passwort", "secret", "your", "example", "dummy", "test", "<", "${", "{{", "process.env", "os.environ", "env(", "getenv", "none", "null", "undefined", "todo", "placeholder", "redacted", "...", "}}"];
    v.len() >= 8 && !placeholders.iter().any(|p| v.contains(p)) && v.chars().any(|c| c.is_ascii_digit() || !c.is_alphanumeric())
}

fn not_placeholder_url(m: &str) -> bool {
    let lower = m.to_lowercase();
    !["user:pass", "username:password", "user:password", "${", "<", "localhost", "example"].iter().any(|p| lower.contains(p))
}

fn real_email(m: &str) -> bool {
    let lower = m.to_lowercase();
    let domain = lower.rsplit('@').next().unwrap_or_default();
    let fake_domains = ["example.", "test", "localhost", "domain.", "email.", "invalid", "users.noreply.github.com", "anthropic.com"];
    let fake_users = ["noreply", "no-reply", "donotreply", "info@", "support@", "admin@", "hello@", "user@", "foo@", "max.mustermann", "john.doe", "jane.doe"];
    !fake_domains.iter().any(|d| domain.starts_with(d) || domain.contains(d)) && !fake_users.iter().any(|u| lower.starts_with(u))
}

/// Beispiel-IBANs aus Dokumentationen und Testdaten – gültig, aber kein echtes Konto.
const EXAMPLE_IBANS: &[&str] = &["DE89370400440532013000", "DE02120300000000202051", "DE75512108001245126199", "GB82WEST12345698765432", "AT611904300234573201"];

/// IBAN-Prüfsumme (ISO 13616, mod 97).
pub fn valid_iban(m: &str) -> bool {
    let s: String = m.chars().filter(|c| !c.is_whitespace()).collect();
    if !(15..=34).contains(&s.len()) {
        return false;
    }
    let rearranged = format!("{}{}", &s[4..], &s[..4]);
    let mut rem: u32 = 0;
    for c in rearranged.chars() {
        let v = match c.to_digit(36) {
            Some(v) => v,
            None => return false,
        };
        for d in v.to_string().chars() {
            rem = (rem * 10 + d.to_digit(10).unwrap()) % 97;
        }
    }
    rem == 1
}

/// Steuerliche Identifikationsnummer: Prüfziffer nach ISO 7064 MOD 11,10 und
/// die Regel, dass in den ersten zehn Ziffern genau eine Ziffer doppelt
/// oder dreifach vorkommt.
pub fn valid_tax_id(m: &str) -> bool {
    let d: Vec<u32> = m.chars().filter_map(|c| c.to_digit(10)).collect();
    if d.len() != 11 || d[0] == 0 {
        return false;
    }
    let mut counts = [0u8; 10];
    for &x in &d[..10] {
        counts[x as usize] += 1;
    }
    let repeated = counts.iter().filter(|&&c| c >= 2).count();
    if repeated != 1 || counts.iter().any(|&c| c > 3) {
        return false;
    }
    let mut product = 10;
    for &x in &d[..10] {
        let mut sum = (x + product) % 10;
        if sum == 0 {
            sum = 10;
        }
        product = (sum * 2) % 11;
    }
    let check = (11 - product) % 10;
    check == d[10]
}

fn mask(s: &str) -> String {
    let chars: Vec<char> = s.chars().filter(|c| !c.is_control()).collect();
    if chars.len() <= 6 {
        return "•".repeat(chars.len().max(3));
    }
    let keep = (chars.len() / 5).clamp(2, 4);
    format!("{}…{}", chars[..keep].iter().collect::<String>(), chars[chars.len() - keep..].iter().collect::<String>())
}

/// Ausschnitt rund um eine Fundstelle, für das Decision-Modell.
fn context_of(text: &str, start: usize, end: usize) -> String {
    let mut a = start.saturating_sub(160);
    let mut b = (end + 160).min(text.len());
    while !text.is_char_boundary(a) {
        a -= 1;
    }
    while !text.is_char_boundary(b) {
        b += 1;
    }
    text[a..b].to_string()
}

/// Lokaler Vorfilter. Liefert Treffer je Kategorie.
pub fn scan(text: &str, source: &str) -> Vec<(&'static str, Hit)> {
    let mut out: Vec<(&'static str, Hit)> = Vec::new();
    for rule in rules() {
        let mut n = 0;
        for m in rule.re.find_iter(text) {
            if rule.check.is_some_and(|c| !c(m.as_str())) {
                continue;
            }
            // Steuer-ID ist ohne Stichwort in der Nähe nur ein Verdacht, Beispiel-IBANs auch.
            let compact: String = m.as_str().chars().filter(|c| !c.is_whitespace()).collect();
            let strong = (rule.strong && !EXAMPLE_IBANS.contains(&compact.as_str()))
                || (rule.label == "Steuer-ID" && context_of(text, m.start(), m.end()).to_lowercase().contains("steuer"));
            let shown = if rule.category == "credentials" || rule.category == "personal" { mask(m.as_str()) } else { m.as_str().chars().take(60).collect() };
            if !out.iter().any(|(_, h)| h.label == rule.label && h.sample == shown) {
                out.push((rule.category, Hit { label: rule.label.into(), sample: shown, source: source.into(), strong, context: context_of(text, m.start(), m.end()) }));
            }
            n += 1;
            if n >= 5 {
                break;
            }
        }
    }
    out
}

/// Fundstellen von Zugangsdaten (Byte-Bereiche des eigentlichen Werts), für
/// das Angebot „als Secret speichern“ im Composer.
pub fn credential_spans(text: &str) -> Vec<(&'static str, usize, usize)> {
    let mut out: Vec<(&'static str, usize, usize)> = Vec::new();
    for rule in rules().iter().filter(|r| r.category == "credentials") {
        for caps in rule.re.captures_iter(text) {
            let m = caps.get(0).unwrap();
            if rule.check.is_some_and(|c| !c(m.as_str())) {
                continue;
            }
            // Nur der Wert, nicht „password =“ bzw. Benutzer und Host der URL.
            let (start, end) = if let Some(g) = caps.get(1) {
                (g.start(), g.end())
            } else if rule.label == "Verbindungs-URL mit Passwort" {
                let s = m.as_str();
                let at = s.rfind('@').unwrap_or(s.len());
                let colon = s[..at].rfind(':').map_or(0, |c| c + 1);
                (m.start() + colon, m.start() + at)
            } else {
                (m.start(), m.end())
            };
            if start < end && !out.iter().any(|(_, s, e)| start < *e && *s < end) {
                out.push((rule.label, start, end));
            }
        }
    }
    out.sort_by_key(|(_, s, _)| *s);
    out
}

fn readable(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return None; // binär
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn local_probability(hits: &[Hit]) -> f64 {
    if hits.iter().any(|h| h.strong) {
        0.95
    } else {
        (0.3 + 0.12 * hits.len() as f64).min(0.7)
    }
}

/// Prüft Prompt und Anhänge. `remote = false` bleibt rein lokal.
pub async fn check(text: &str, attachments: &[String], cwd: Option<&str>, remote: bool, model: Option<&str>) -> Verdict {
    let mut found = scan(text, "Prompt");
    let mut unreadable = Vec::new();
    for a in attachments {
        let path = match cwd {
            Some(c) if !std::path::Path::new(a).is_absolute() => std::path::Path::new(c).join(a).to_string_lossy().to_string(),
            _ => a.clone(),
        };
        let name = std::path::Path::new(a).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| a.clone());
        match readable(&path) {
            Some(content) => found.extend(scan(&content, &name)),
            None => unreadable.push(name),
        }
    }

    let mut categories: Vec<Category> = CATEGORIES
        .iter()
        .filter_map(|(id, label, _)| {
            let hits: Vec<Hit> = found.iter().filter(|(c, _)| c == id).map(|(_, h)| h.clone()).collect();
            (!hits.is_empty()).then(|| {
                let reason = format!("{} gefunden", hits.iter().map(|h| h.label.as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>().join(", "));
                Category { id, label, probability: local_probability(&hits), hits, reason }
            })
        })
        .collect();

    let mut verdict = Verdict { flagged: false, categories: Vec::new(), reason: String::new(), checked_by: "local", model: None, ms: 0, cost_eur: 0.0, unreadable, error: None };

    if !found.is_empty() && remote && crate::cortecs::available() {
        // Datensparsam: Prompt (gekürzt) und Ausschnitte rund um Treffer in Anhängen.
        let mut input = format!("User prompt to a coding assistant:\n{}\n", text.chars().take(4000).collect::<String>());
        let snippets: Vec<String> = found.iter().filter(|(_, h)| h.source != "Prompt").take(12).map(|(_, h)| format!("[{}] …{}…", h.source, h.context)).collect();
        if !snippets.is_empty() {
            input.push_str("\nExcerpts from attached files:\n");
            input.push_str(&snippets.join("\n").chars().take(5000).collect::<String>());
        }
        let questions: Vec<Value> = CATEGORIES.iter().map(|(id, _, q)| json!({ "type": "predicate", "name": id, "instructions": q })).collect();
        match crate::cortecs::decide("Sensibilität", &input, json!(questions), model, Duration::from_secs(8)).await {
            Ok(d) => {
                verdict.checked_by = "cortecs";
                verdict.model = Some(d.model);
                verdict.ms = d.ms;
                verdict.cost_eur = d.cost_eur;
                for (id, label, _) in CATEGORIES {
                    let Some(p) = d.answers.get(*id).and_then(|a| a["probability"].as_f64()) else { continue };
                    match categories.iter_mut().find(|c| c.id == *id) {
                        Some(c) => {
                            // Eindeutige lokale Funde (Prüfsumme, Schlüsselformat) bleiben hoch.
                            c.probability = if c.hits.iter().any(|h| h.strong) { c.probability.max(p) } else { p };
                            c.reason = format!("{} · Modell: {}", c.reason, pct(p));
                        }
                        None if p >= THRESHOLD => categories.push(Category { id, label, probability: p, hits: vec![], reason: format!("Modell: {}", pct(p)) }),
                        None => {}
                    }
                }
            }
            Err(e) => verdict.error = Some(e),
        }
    }

    // Ohne Modell: eindeutige Funde oder mehrere Verdachtsmomente in einer Kategorie.
    let local_only = verdict.checked_by == "local";
    categories.retain(|c| if local_only { c.hits.iter().any(|h| h.strong) || c.hits.len() >= 2 || matches!(c.id, "special" | "secrecy203" | "aiact" | "credentials") } else { c.probability >= THRESHOLD });
    categories.sort_by(|a, b| b.probability.total_cmp(&a.probability));
    verdict.flagged = !categories.is_empty();
    verdict.reason = categories.iter().map(|c| format!("{} ({})", c.label, pct(c.probability))).collect::<Vec<_>>().join(", ");
    verdict.categories = categories;
    verdict
}

fn pct(p: f64) -> String {
    format!("{:.0} %", p * 100.0)
}

#[tauri::command]
pub async fn sensitivity_check(text: String, attachments: Vec<String>, cwd: Option<String>, remote: Option<bool>, model: Option<String>) -> CmdResult<Verdict> {
    Ok(check(&text, &attachments, cwd.as_deref(), remote.unwrap_or(true), model.as_deref()).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(text: &str) -> Vec<String> {
        scan(text, "Prompt").into_iter().map(|(_, h)| h.label).collect()
    }

    #[test]
    fn iban_checksum() {
        assert!(valid_iban("DE89 3704 0044 0532 0130 00"));
        assert!(!valid_iban("DE89 3704 0044 0532 0130 01"));
    }

    #[test]
    fn tax_id_checksum() {
        assert!(valid_tax_id("86095742719"));
        assert!(!valid_tax_id("86095742718"));
        assert!(!valid_tax_id("12345678901"));
    }

    #[test]
    fn finds_secrets_but_not_placeholders() {
        assert!(labels("AKIAIOSFODNN7EXAMPLE").contains(&"AWS-Zugangsschlüssel".to_string()));
        assert!(labels("password = \"S3cure#Pass\"").contains(&"Passwort/Token im Klartext".to_string()));
        assert!(labels("password = process.env.DB_PASSWORD").is_empty());
        assert!(labels("api_key: \"<your-key-here>\"").is_empty());
        assert!(labels("echo \"Token: {{secret:DEMO_TOKEN}}\"").is_empty());
    }

    #[test]
    fn ignores_example_emails() {
        assert!(labels("Schreib an test@example.com").is_empty());
        assert!(labels("Co-Authored-By: Claude <noreply@anthropic.com>").is_empty());
        assert_eq!(labels("Kontakt: anna.schmidt@kanzlei-schmidt.de"), vec!["E-Mail-Adresse"]);
    }

    #[test]
    fn code_question_is_clean() {
        assert!(labels("Refactore die Funktion parse_config in src/config.rs und schreib Tests dafür.").is_empty());
    }

    #[test]
    fn health_and_ai_act() {
        assert!(!labels("Die Patientin hat die Diagnose Depression").is_empty());
        assert!(labels("Baue ein Tool, das Bewerber automatisch nach Lebenslauf rankt").iter().any(|l| l.starts_with("Hochrisiko")));
    }

    #[test]
    fn credential_value_spans() {
        let text = "Nimm password = \"S3cure#Pass\" und ghp_abcdefghijklmnopqrstuvwxyz0123456789 sowie postgres://app:geheim123@db/x";
        let spans: Vec<&str> = credential_spans(text).into_iter().map(|(_, s, e)| &text[s..e]).collect();
        assert_eq!(spans, vec!["S3cure#Pass", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "geheim123"]);
    }

    #[test]
    fn masks_values() {
        assert_eq!(mask("DE89370400440532013000"), "DE89…3000");
    }
}
