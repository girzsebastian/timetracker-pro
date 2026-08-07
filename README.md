# TimeTracker Pro

Time tracker self-hosted pentru firme de mentenanță software: **bază de date reală**, **AI local gratuit** (Ollama/Llama), **comandă vocală** („dă-i drumul" → vorbești → execută acțiuni), **filtre avansate** și **export PDF** cu tot.

Zero costuri recurente de AI — modelul rulează pe calculatorul tău. Merge cu **Wispr Flow** (dictezi în câmpul de comandă) sau cu recunoașterea vocală din browser.

## Pornire (un singur script)

```bash
cd time-tracker
./start.sh
```
Scriptul instalează dependențele, pornește Ollama, descarcă modelul (o singură dată) și deschide `http://localhost:5555`.

Manual:
```bash
npm install
npm start          # http://localhost:5555
```

## Docker local (recomandat pentru utilizare zilnică)

Aplicația rulează în container pe **http://localhost:8888**, cu baza de date păstrată pe disc în `data/` (aceeași ca la rularea manuală — nu rula ambele simultan).

```bash
docker start timetracker     # pornește
docker stop timetracker      # oprește
docker logs timetracker      # loguri
```

Containerul repornește singur după restart de Mac (dacă Docker Desktop e deschis), mai puțin dacă l-ai oprit tu explicit.

Prima creare (o singură dată, sau după modificări de cod):
```bash
docker build -t timetracker .
docker rm -f timetracker 2>/dev/null
docker run -d --name timetracker --restart unless-stopped \
  -p 127.0.0.1:8888:5555 \
  -v "$PWD/data:/app/data" \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  timetracker
```

Pentru hosting public există autentificare: setează `APP_PASSWORD` (și opțional `APP_USER`) — fără ele aplicația rulează deschis, ca local.

## AI local (gratuit)

1. Instalează [Ollama](https://ollama.com) (macOS/Windows/Linux)
2. `ollama pull qwen2.5:7b-instruct` (~4-5GB, o singură dată)
3. Gata — comenzile vocale și rapoartele rulează local, fără API key, fără costuri

Aplicația funcționează și fără Ollama (tracking, filtre, PDF), doar partea de AI e inactivă. Modelul se alege din **Setări**.

## „Dă-i drumul" — comandă vocală

Apasă **⌘K** (sau butonul din dreapta-jos), apoi **vorbește sau scrie** o comandă. AI-ul local o interpretează, îți arată **exact ce a înțeles** (client / proiect / persoană rezolvate), tu confirmi cu **„Dă-i drumul"**, iar acțiunea se execută.

Exemple:
- „pornește cronometru pentru mentenanță la Alvanda, persoana Ana, tag bug"
- „adaugă 2 ore la Neuros, descriere fix login"
- „filtrează pe Dr. Lupu luna asta și exportă PDF"
- „du-te la clienți" · „oprește cronometrul"

**Siguranță:** citirile (filtrare, navigare) rulează direct; **scrierile** (adăugare, creare) cer confirmare vizuală; **ștergerile** cer confirmare dublă. AI-ul nu poate face nimic ce nu poate face și API-ul — totul trece prin același registry pe server.

### Cu Wispr Flow
Deschide consola (⌘K), pune cursorul în câmp, dictează cu Wispr — textul intră în câmp, apoi apeși „Interpretează" → „Dă-i drumul".

## Ce include

- **Panou** — KPI-uri, clienți (ore vs. pachet), distribuție pe persoană
- **Cronometru** persistent + adăugare manuală
- **Clienți & Pachete** (abonament €/lună + ore incluse), **Proiecte**, **Echipă**
- **Filtre partajate** (client, persoană, text, dată, taguri) care afectează panoul, înregistrările, raportul și PDF-ul
- **Raport AI** — generat local, streaming, pentru client (extern) sau intern
- **Export PDF** — document brandat cu tot: KPI, clienți vs. pachet, pe persoană, pe tag, jurnal complet pe zile, rezumat AI
- **Jurnal comenzi** — audit al acțiunilor (UI / voce)

## Arhitectură

```
time-tracker/
├── server/
│   ├── index.js     Fastify — servește UI + REST /api
│   ├── db.js        SQLite (better-sqlite3, WAL) + seed
│   ├── actions.js   registry central de acțiuni (singura sursă care scrie) + resolver fuzzy
│   ├── ollama.js    AI local: parsare comenzi (JSON constrâns) + rapoarte streaming
│   └── pdf.js       export PDF (pdfmake, font Roboto cu diacritice)
├── public/          UI vanilla (index.html, app.js, style.css)
├── data/            baza de date (timetracker.db) — backup = copiază fișierul
├── start.sh         pornire într-un pas
└── DECISION-RECORD.md  deciziile consiliului de agenți
```

**Stack:** Node 20 + Fastify + better-sqlite3, UI vanilla, Ollama pentru AI local, pdfmake pentru PDF. Fără framework, fără cont cloud, fără costuri recurente.

Deciziile de arhitectură/design/UX au fost votate de un consiliu de 12 agenți AI — vezi [DECISION-RECORD.md](./DECISION-RECORD.md).
