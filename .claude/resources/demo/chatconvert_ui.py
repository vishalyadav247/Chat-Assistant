#!/usr/bin/env python3
"""
ChatConvert — Desktop UI (Python / Tkinter).  NO HTML.

Reads ALL data live from data-sources/:
    products.json, knowledge.json, curated_answers.json, guardrails.json, persona.json
Runs the real pipeline (OpenAI embeddings + gpt-4o-mini) and shows, per message:
    * the chat reply + product cards (inline chat bubbles)
    * the workflow PATH lighting up on the left
    * a "how it worked" breakdown
Remembers the conversation within a session (chat history is sent to the model).

Vector search is in-memory numpy (same cosine math pgvector uses; keeps the app
dependency-light). Production uses Postgres + pgvector — see PRODUCTION-BUILD-SPEC.md.

------------------------------------------------------------------------------
SETUP:  pip install openai numpy
        Put your OpenAI key in OPENAI_API_KEY below (or set the env var, or use the field).
RUN:    python chatconvert_ui.py
Buttons: "Connect / Reconnect" (embeds the data)   ·   "Reload data" (re-read the JSON files)
------------------------------------------------------------------------------
"""
import os, re, json, threading, queue
import numpy as np
import tkinter as tk
from tkinter import scrolledtext
from prompts import (ROUTER, SUMMARY_SYS, CHAT_REPLY, QUESTION_ANSWER, PRODUCT_RECOMMEND,
                     CURATED_CONFIRM_SYS, curated_confirm_user, build_system_prompt)

# ---- conversation-history settings ----
RECENT_LIMIT = 10   # send at most the last 10 messages verbatim to the model
SUMMARY_EVERY = 4   # re-summarize the older turns every 4 messages (to save tokens)

# ⇩⇩⇩ PASTE YOUR OPENAI API KEY HERE (or leave "" to use the env var / the field) ⇩⇩⇩
OPENAI_API_KEY = ""
# ⇧⇧⇧ ------------------------------------------------------------------------ ⇧⇧⇧

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data-sources")
EMBED_MODEL, CHAT_MODEL = "text-embedding-3-small", "gpt-4o-mini"

# ------------------------------------------------------------------ load data files (from data-sources/)
def load(fname, default):
    try:
        with open(os.path.join(DATA_DIR, fname), encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"(default for {fname}: {e})"); return default

def reload_data():
    """Re-read every JSON file from data-sources/ into the globals (used by the Reload button)."""
    global PRODUCTS, KNOWLEDGE, CURATED, GUARD, PERSONA
    PRODUCTS  = load("products.json", [])
    KNOWLEDGE = load("knowledge.json", [])
    CURATED   = load("curated_answers.json", [])
    GUARD     = load("guardrails.json", {"bannedTopics":[],"fallbackMessage":"","minMeaningScore":0.3,"curatedMatchThreshold":0.8,"answerOnlyFromKnowledge":True})
    PERSONA   = load("persona.json", {"assistantName":"Assistant","role":"You are a shop assistant."})

reload_data()  # initial load

# ------------------------------------------------------------------ OpenAI (lazy)
_client = None
def client():
    global _client
    if _client is None:
        from openai import OpenAI
        _client = OpenAI()
    return _client
def embed_many(texts): return [d.embedding for d in client().embeddings.create(model=EMBED_MODEL, input=texts).data]
def unit(v): v=np.array(v,dtype=float); n=np.linalg.norm(v); return v/n if n else v
def chat_call(messages, temperature=0.3, max_tokens=220):
    r=client().chat.completions.create(model=CHAT_MODEL, temperature=temperature, max_tokens=max_tokens, messages=messages)
    return r.choices[0].message.content.strip()
def summarize_history(older_msgs):
    """Roll the older turns up into a short cached summary — saves tokens on long chats."""
    convo="\n".join(f"{m['role']}: {m['content']}" for m in older_msgs)
    return chat_call([{"role":"system","content":SUMMARY_SYS},{"role":"user","content":convo}], 0.2, 130)
def moderation_flag(text):
    """FREE OpenAI moderation for universal-unsafe content (sexual/hate/violence/self-harm).
    In production, run this in PARALLEL with the router so it adds ~0 latency."""
    try:
        res=client().moderations.create(model="omni-moderation-latest", input=text).results[0]
        if res.flagged:
            return True, [k for k,v in res.categories.model_dump().items() if v]
    except Exception as e:
        print("moderation error:", e)
    return False, []
def llm_confirm_same(msg, question):
    """Cheap yes/no used ONLY for borderline curated scores: does the message mean the same?"""
    a=chat_call([{"role":"system","content":CURATED_CONFIRM_SYS},
                 {"role":"user","content":curated_confirm_user(msg, question)}],0,3)
    return a.strip().lower().startswith("y")

P_VEC=[]; K_VEC=[]; CUR_VEC=[]; BANNED_VEC=[]
def build_index():
    """Embed products + knowledge + curated questions + banned topics (Connect/Reload)."""
    global P_VEC,K_VEC,CUR_VEC,BANNED_VEC
    P_VEC=[unit(v) for v in embed_many([f"{p['title']}. {p['description']}" for p in PRODUCTS])]
    K_VEC=[unit(v) for v in embed_many([f"{k['topic']}. {k['body']}" for k in KNOWLEDGE])]
    CUR_VEC=[unit(v) for v in embed_many([c["question"]+" "+" ".join(c.get("synonyms",[])) for c in CURATED])] if CURATED else []
    bt=GUARD.get("bannedTopics",[])
    # embed each banned TOPIC as a phrase so a full sentence's meaning can match it
    BANNED_VEC=[unit(v) for v in embed_many([f"a message about {t}" for t in bt])] if bt else []

# ------------------------------------------------------------------ pipeline
def system_prompt():
    return build_system_prompt(PERSONA)   # persona voice, assembled in prompts.py

BANNED_STOP={"advice","pricing","content","message","about"}
def banned_check(msg, q):
    """HYBRID guardrail: literal keyword → moderation API (universal) → embeddings (store-specific meaning).
    (Production also folds a 'blocked' flag into the router LLM for nuanced/store-specific topics.)"""
    m=msg.lower()
    for t in GUARD.get("bannedTopics",[]):                        # 1) fast literal catch
        words=[w for w in re.findall(r"[a-z]+",t.lower()) if w not in BANNED_STOP]
        if any(w in m for w in words): return (t, 1.0, "keyword")
    flagged, cats = moderation_flag(msg)                          # 2) moderation API (FREE) — universal unsafe
    if flagged: return (", ".join(cats) or "unsafe content", 1.0, "moderation")
    if BANNED_VEC:                                                # 3) embeddings — store-specific topics by meaning
        sims=[float(np.dot(q,bv)) for bv in BANNED_VEC]
        i=int(np.argmax(sims))
        if sims[i]>=GUARD.get("bannedMatchThreshold",0.35):
            return (GUARD["bannedTopics"][i], sims[i], "meaning")
    return None

def curated_check(q, msg):
    """HYBRID curated match: embeddings find the nearest question; high score → use it; borderline → LLM confirms."""
    if not CUR_VEC: return None
    sims=[float(np.dot(q,cv)) for cv in CUR_VEC]
    i=int(np.argmax(sims)); best=sims[i]
    hi=GUARD.get("curatedMatchThreshold",0.8); lo=GUARD.get("curatedBorderline",0.65)
    if best>=hi: return (CURATED[i], best, "meaning")
    if best>=lo and llm_confirm_same(msg, CURATED[i]["question"]):   # borderline → cheap LLM yes/no
        return (CURATED[i], best, "meaning+LLM confirm")
    return None

def route(msg, history=None):
    sys=ROUTER                                # from prompts.py
    banned=GUARD.get("bannedTopics",[])
    if banned: sys += "\nBANNED TOPICS: " + ", ".join(banned)
    scope=PERSONA.get("scope","")
    if scope:  sys += "\nSTORE SCOPE: " + scope     # for off-topic detection
    msgs=[{"role":"system","content":sys}]+(history or [])+[{"role":"user","content":msg}]
    raw=re.sub(r"^```json|```$","",chat_call(msgs,0,160)).strip()
    try: d=json.loads(raw)
    except Exception: d={"intent":"buy","price_max":None,"keywords":msg.split()[:3]}
    d.setdefault("intent","buy"); d.setdefault("price_max",None); d.setdefault("keywords",[])
    d.setdefault("blocked",False); d.setdefault("blocked_reason","")
    d.setdefault("off_topic",False); d.setdefault("off_topic_reason",""); return d

def keyword_search(keys, cap):
    out=[]
    for p in PRODUCTS:
        if p["stock"]<=0: continue
        if cap and p["price"]>cap: continue
        if not keys: continue
        hay=(p["title"]+" "+p["description"]).lower()
        if any(str(k).lower() in hay for k in keys): out.append(p)
    return out
def vector_search(q, cap, k=5):
    scored=[(p,float(np.dot(q,P_VEC[i]))) for i,p in enumerate(PRODUCTS) if p["stock"]>0 and (not cap or p["price"]<=cap)]
    scored.sort(key=lambda x:-x[1]); return scored[:k]
def rag_search(q, k=3):
    scored=[(KNOWLEDGE[i],float(np.dot(q,K_VEC[i]))) for i in range(len(KNOWLEDGE))]
    scored.sort(key=lambda x:-x[1]); return scored[:k]

def handle(msg, history=None):
    steps=[]; hist=history or []
    q=unit(embed_many([msg])[0])          # embed the shopper message ONCE, reuse everywhere
    bt=banned_check(msg, q)
    if bt:
        topic,score,method=bt
        return {"path":"banned","reply":GUARD.get("fallbackMessage",""),"products":[],
                "steps":[("Guardrail", f"blocked '{topic}' by {method} (score {score:.2f})")]}
    cu=curated_check(q, msg)
    if cu:
        ans,score,how=cu
        return {"path":"curated","reply":ans["talkingPoints"],
                "products":[(t, next((p["price"] for p in PRODUCTS if p["title"]==t),"")) for t in ans["products"]],
                "steps":[("Curated answer", f"matched by {how} (score {score:.2f})")]}
    r=route(msg, hist)
    if r.get("blocked"):                                          # store-specific guardrail — LLM understood the meaning
        return {"path":"banned","reply":GUARD.get("fallbackMessage",""),"products":[],
                "steps":[("Guardrail (router LLM)", f"blocked '{r.get('blocked_reason') or 'banned topic'}' — understood by meaning, no keyword needed")]}
    if r.get("off_topic"):                                        # OUT OF STORE SCOPE — polite redirect (not blocked)
        return {"path":"chat","reply":PERSONA.get("offTopicMessage") or "I can only help with our store's products and orders.","products":[],
                "steps":[("Off-topic", f"'{r.get('off_topic_reason') or 'out of scope'}' is outside the store scope → polite redirect, no lookup")]}
    steps.append(("Router", f"intent={r['intent']} price_max={r['price_max']} keywords={r['keywords']}"))
    if r["intent"]=="chat":
        msgs=[{"role":"system","content":system_prompt()+"\n"+CHAT_REPLY}]+hist+[{"role":"user","content":msg}]
        steps.append(("Chat","no catalog lookup"))
        return {"path":"chat","reply":chat_call(msgs,0.5,60),"products":[],"steps":steps}
    if r["intent"]=="question":
        docs=rag_search(q)
        for d,s in docs: steps.append(("RAG", f"{d['topic']} ({s:.2f})"))
        if GUARD.get("answerOnlyFromKnowledge") and (not docs or docs[0][1]<GUARD.get("minMeaningScore",0.3)):
            return {"path":"question","reply":GUARD.get("fallbackMessage",""),"products":[],"steps":steps}
        ctx="\n".join(f"[{d['topic']}] {d['body']}" for d,_ in docs)
        sys_a=system_prompt()+"\n"+QUESTION_ANSWER
        msgs=[{"role":"system","content":sys_a}]+hist+[{"role":"user","content":f"Store info:\n{ctx}\n\nQuestion: {msg}"}]
        return {"path":"question","reply":chat_call(msgs),"products":[],"steps":steps}
    # buy
    kw=keyword_search(r["keywords"], r["price_max"])
    steps.append(("Keyword", (", ".join(r["keywords"]) or "—")+" -> "+(", ".join(p["title"] for p in kw) if kw else "NOTHING")))
    vec=vector_search(q, r["price_max"])
    steps.append(("Vector", " | ".join(f"{p['title']} {s:.2f}" for p,s in vec)))
    cands={p["title"]:p["price"] for p in kw}
    for p,s in vec:
        if s>=GUARD.get("minMeaningScore",0.3): cands[p["title"]]=p["price"]
    if not cands and r["price_max"]:
        browse=sorted([p for p in PRODUCTS if p["stock"]>0 and p["price"]<=r["price_max"]], key=lambda x:x["price"])[:4]
        for p in browse: cands[p["title"]]=p["price"]
        if browse: steps.append(("Filter browse", f"no specific match -> items under ${r['price_max']}"))
    if not cands:
        steps.append(("No match","ask, don't guess"))
        return {"path":"buy","reply":"I couldn't find a match — what kind of item are you after?","products":[],"steps":steps}
    steps.append(("Grounding","LLM may ONLY use: "+", ".join(cands.keys())))
    cj=json.dumps([{"title":t,"price":p} for t,p in cands.items()])
    sys_p=system_prompt()+"\n"+PRODUCT_RECOMMEND
    msgs=[{"role":"system","content":sys_p}]+hist+[{"role":"user","content":f"Candidates JSON: {cj}\n\nShopper said: {msg}"}]
    return {"path":"buy","reply":chat_call(msgs),"products":list(cands.items())[:4],"steps":steps}

# ================================================================== UI
PATHS={"banned":{"msg","guard","fallback","result"},
       "curated":{"msg","guard","curated","curatedReply","result"},
       "buy":{"msg","guard","curated","router","buy","result"},
       "question":{"msg","guard","curated","router","question","result"},
       "chat":{"msg","guard","curated","router","chat","result"}}

BG="#f6f8fb"; INK="#0f172a"; ACC="#3b6fd4"; TEALBTN="#0d9488"; MUT="#64748b"
GRAY="#eef1f5"; TEAL="#d8f2ee"; BLUE="#e2edff"; GREEN="#e4f6ea"; DIM="#f4f6f9"

class App:
    def __init__(self, root):
        self.root=root; root.title("ChatConvert — LLM Studio (Python)"); root.configure(bg=BG); root.geometry("1180x880")
        self.q=queue.Queue(); self.connected=False; self.history=[]; self.summary=""; self.thinking=None

        top=tk.Frame(root,bg=BG); top.pack(fill="x",padx=12,pady=(10,4))
        tk.Label(top,text="OpenAI API key:",bg=BG,fg=INK).pack(side="left")
        self.key=tk.Entry(top,show="•",width=42); self.key.pack(side="left",padx=6)
        prefill = OPENAI_API_KEY or os.environ.get("OPENAI_API_KEY","")
        if prefill: self.key.insert(0, prefill)
        self.connectBtn=tk.Button(top,text="Connect / Reconnect",command=self.connect,bg=ACC,fg="white",relief="flat",padx=10)
        self.connectBtn.pack(side="left",padx=6)
        self.reloadBtn=tk.Button(top,text="Reload data",command=self.reload,bg=TEALBTN,fg="white",relief="flat",padx=10)
        self.reloadBtn.pack(side="left",padx=(0,6))
        self.status=tk.Label(top,text="not connected",bg=BG,fg="#a23b3b"); self.status.pack(side="left",padx=8)

        self.info=tk.Label(root,bg=BG,fg=MUT,anchor="w",text=self._info_text()); self.info.pack(fill="x",padx=14)

        main=tk.Frame(root,bg=BG); main.pack(fill="both",expand=True,padx=12,pady=8)
        main.columnconfigure(0,weight=1,uniform="h"); main.columnconfigure(1,weight=1,uniform="h"); main.rowconfigure(0,weight=1)

        # ===== LEFT HALF: workflow diagram + details =====
        left=tk.Frame(main,bg=BG); left.grid(row=0,column=0,sticky="nsew",padx=(0,8))
        wf=tk.LabelFrame(left,text="Workflow — the path lights up per message",bg=BG,fg=INK,padx=6,pady=6); wf.pack(fill="both",expand=True)
        self.nodes={}
        self.canvas=tk.Canvas(wf,width=462,height=530,bg="white",highlightthickness=0)
        self.canvas.pack(anchor="n")
        lg=tk.Frame(wf,bg=BG); lg.pack(fill="x",pady=(6,0))
        for c,txt in [(BLUE,"OpenAI call"),(TEAL,"your data/rules"),(GREEN,"result")]:
            tk.Label(lg,text="  ",bg=c,relief="solid",bd=1).pack(side="left",padx=(0,3))
            tk.Label(lg,text=txt,bg=BG,fg=MUT,font=("Segoe UI",8)).pack(side="left",padx=(0,10))
        hw=tk.LabelFrame(left,text="How it worked (details)",bg=BG,fg=INK,padx=6,pady=4); hw.pack(fill="both",pady=(8,0))
        self.steps=scrolledtext.ScrolledText(hw,height=9,wrap="word",font=("Consolas",9),bg="#fbfcfe",fg=INK,relief="flat",state="disabled")
        self.steps.pack(fill="both",expand=True)
        self.build_canvas()

        # ===== RIGHT HALF: chat (inline bubbles) =====
        center=tk.Frame(main,bg=BG); center.grid(row=0,column=1,sticky="nsew")
        chatBox=tk.Frame(center,bg="white",highlightthickness=1,highlightbackground="#e4e8ef"); chatBox.pack(fill="both",expand=True)
        self.chatCanvas=tk.Canvas(chatBox,bg="white",highlightthickness=0)
        sb=tk.Scrollbar(chatBox,orient="vertical",command=self.chatCanvas.yview); self.chatCanvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right",fill="y"); self.chatCanvas.pack(side="left",fill="both",expand=True)
        self.chatInner=tk.Frame(self.chatCanvas,bg="white")
        self.winId=self.chatCanvas.create_window((0,0),window=self.chatInner,anchor="nw")
        self.chatInner.bind("<Configure>", lambda e:self.chatCanvas.configure(scrollregion=self.chatCanvas.bbox("all")))
        self.chatCanvas.bind("<Configure>", lambda e:self.chatCanvas.itemconfig(self.winId,width=e.width))
        self.chatCanvas.bind_all("<MouseWheel>", lambda e:self.chatCanvas.yview_scroll(int(-e.delta/120),"units"))

        inrow=tk.Frame(center,bg=BG); inrow.pack(fill="x",pady=(8,0))
        self.entry=tk.Entry(inrow,font=("Segoe UI",11)); self.entry.pack(side="left",fill="x",expand=True,ipady=5)
        self.entry.bind("<Return>",lambda e:self.send())
        self.sendBtn=tk.Button(inrow,text="Send",command=self.send,bg=ACC,fg="white",relief="flat",padx=16,state="disabled")
        self.sendBtn.pack(side="left",padx=(6,0))

        sug=tk.Frame(root,bg=BG); sug.pack(fill="x",padx=12,pady=(0,10))
        for s in ["what are your best sellers?","keep my hands warm under $30","do you ship to Canada?",
                  "what do you recommend for the kitchen?","can you give me medical advice?","hi there","product under 20 dollar"]:
            tk.Button(sug,text=s,command=lambda x=s:self.send(x),bg="white",fg="#33405a",relief="groove",
                      font=("Segoe UI",9),padx=6,pady=2).pack(side="left",padx=3)

        self.root.after(80,self.pump)

    # ---- helpers
    def _info_text(self):
        return (f"Loaded from data-sources/ → products: {len(PRODUCTS)} | knowledge: {len(KNOWLEDGE)} | curated: {len(CURATED)} | "
                f"banned topics: {len(GUARD.get('bannedTopics',[]))} | persona: {PERSONA.get('assistantName','?')}")
    def set_status(self,txt,ok=False): self.status.config(text=txt,fg=("#177245" if ok else "#a23b3b"))

    # ---- workflow canvas
    def _box(self,name,x1,y1,x2,y2,label,fill,fs=9):
        r=self.canvas.create_rectangle(x1,y1,x2,y2,fill=fill,outline="#c7cfda",width=1)
        t=self.canvas.create_text((x1+x2)//2,(y1+y2)//2,text=label,fill=INK,width=(x2-x1-8),justify="center",font=("Segoe UI",fs))
        self.nodes[name]={"rect":r,"text":t,"fill":fill}
    def _arrow(self,x1,y1,x2,y2): self.canvas.create_line(x1,y1,x2,y2,arrow="last",fill="#94a3b8",width=1.4)
    def build_canvas(self):
        self._box("msg",70,14,290,48,"Shopper message",GRAY,10)
        self._arrow(180,48,180,62)
        self._box("guard",70,64,290,110,"1 · Guardrail\n(banned topics?)",TEAL,10)
        self._box("fallback",310,70,452,104,"Fallback reply",GREEN,9)
        self._arrow(290,87,310,87); self._arrow(180,110,180,124)
        self._box("curated",70,126,290,172,"2 · Curated match?",TEAL,10)
        self._box("curatedReply",310,132,452,166,"Curated reply\n(no LLM)",GREEN,9)
        self._arrow(290,149,310,149); self._arrow(180,172,180,186)
        self._box("router",70,188,290,234,"3 · Router\n(gpt-4o-mini · picks lane)",BLUE,10)
        self._arrow(180,234,84,256); self._arrow(180,234,232,256); self._arrow(180,234,380,256)
        self._box("buy",14,258,154,470,"BUY\n———\nkeyword +\nvector search\n↓\nmerge + browse\n↓\nLLM (grounded)\n↓\nproduct cards",BLUE,9)
        self._box("question",162,258,302,470,"QUESTION\n———\nRAG search\n(knowledge)\n↓\nLLM answers\nfrom snippets\n↓\nanswer",BLUE,9)
        self._box("chat",310,258,450,470,"CHAT\n———\nLLM reply\n(persona)\n↓\nreply",BLUE,9)
        self._arrow(84,470,232,484); self._arrow(232,470,232,484); self._arrow(380,470,232,484)
        self._box("result",70,486,394,520,"Result → shown in chat",GREEN,10)
        self.highlight(None)
    def highlight(self,path):
        active=PATHS.get(path)
        for name,n in self.nodes.items():
            if active is None:
                self.canvas.itemconfig(n["rect"],fill=n["fill"],outline="#c7cfda",width=1); self.canvas.itemconfig(n["text"],fill=INK)
            elif name in active:
                self.canvas.itemconfig(n["rect"],fill=n["fill"],outline=ACC,width=3); self.canvas.itemconfig(n["text"],fill=INK)
            else:
                self.canvas.itemconfig(n["rect"],fill=DIM,outline="#e4e8ef",width=1); self.canvas.itemconfig(n["text"],fill="#aab2c0")

    # ---- inline chat bubbles
    def _scroll_bottom(self): self.root.after(20, lambda: self.chatCanvas.yview_moveto(1.0))
    def add_bubble(self, text, who="bot"):
        row=tk.Frame(self.chatInner,bg="white"); row.pack(fill="x",padx=8,pady=3)
        if who=="user":
            tk.Label(row,text=text,bg=ACC,fg="white",wraplength=340,justify="left",font=("Segoe UI",11),padx=11,pady=7).pack(side="right")
        else:
            tk.Label(row,text=text,bg="#eef2f8",fg=INK,wraplength=340,justify="left",font=("Segoe UI",11),padx=11,pady=7).pack(side="left")
        self._scroll_bottom(); return row
    def add_product_cards(self, prods):
        for t,p in prods:
            row=tk.Frame(self.chatInner,bg="white"); row.pack(fill="x",padx=16,pady=1)
            tk.Label(row,text=f"🛍  {t}     ${p}",bg="#eef7f0",fg="#177245",font=("Segoe UI",10,"bold"),padx=10,pady=5,justify="left").pack(side="left")
        self._scroll_bottom()
    def show_steps(self,steps,path):
        self.steps.config(state="normal"); self.steps.delete("1.0","end")
        self.steps.insert("end",f"PATH: {path.upper()}\n\n")
        for tag,txt in steps: self.steps.insert("end",f"[{tag}]\n{txt}\n\n")
        self.steps.config(state="disabled")

    # ---- actions (network on background threads)
    def connect(self):
        k=self.key.get().strip()
        if not k: self.set_status("enter your key (in code, env, or the field) first"); return
        os.environ["OPENAI_API_KEY"]=k
        self.set_status("embedding data via OpenAI…"); self.connectBtn.config(state="disabled"); self.reloadBtn.config(state="disabled")
        threading.Thread(target=self._connect_worker,daemon=True).start()
    def _connect_worker(self):
        try:
            global _client; _client=None; build_index(); self.q.put(("connected",None))
        except Exception as e:
            self.q.put(("cerror",str(e)))
    def reload(self):
        self.set_status("reloading data from files…", ok=True); self.reloadBtn.config(state="disabled")
        threading.Thread(target=self._reload_worker,daemon=True).start()
    def _reload_worker(self):
        try:
            reload_data()
            if self.connected: build_index()      # re-embed the new data
            self.q.put(("reloaded",None))
        except Exception as e:
            self.q.put(("cerror",str(e)))
    def send(self,text=None):
        if not self.connected: self.set_status("connect first"); return
        msg=(text or self.entry.get()).strip()
        if not msg: return
        self.entry.delete(0,"end"); self.add_bubble(msg,"user")
        prior=list(self.history); self.history.append({"role":"user","content":msg})
        self.entry.config(state="disabled"); self.sendBtn.config(state="disabled"); self.highlight(None)
        self.set_status("thinking…",ok=True); self.thinking=self.add_bubble("…","bot")
        threading.Thread(target=self._send_worker,args=(msg,prior,self.summary),daemon=True).start()
    def _send_worker(self, msg, prior, prev_summary):
        try:
            recent = prior[-RECENT_LIMIT:]                 # last 10 messages, sent verbatim
            older  = prior[:-RECENT_LIMIT]                 # everything before the window
            summary = prev_summary
            if older and (not summary or len(older) % SUMMARY_EVERY == 0):
                summary = summarize_history(older)         # roll older turns into a short summary (saves tokens)
            context = ([{"role":"system","content":"Earlier conversation summary: "+summary}] if summary else []) + recent
            res = handle(msg, context)
            res["_summary"] = summary
            res.setdefault("steps", []).insert(0, ("Context",
                f"sent last {len(recent)} msg" + (" + summary" if summary else "") + f"  (full history: {len(prior)})"))
            self.q.put(("reply", res))
        except Exception as e:
            self.q.put(("rerror", str(e)))

    # ---- main-thread queue pump
    def pump(self):
        try:
            while True:
                kind,payload=self.q.get_nowait()
                if kind=="connected":
                    self.connected=True; self.set_status("connected — start chatting",ok=True)
                    self.entry.config(state="normal"); self.sendBtn.config(state="normal")
                    self.connectBtn.config(state="normal"); self.reloadBtn.config(state="normal")
                    self.add_bubble(f"{PERSONA.get('assistantName','Assistant')}: {PERSONA.get('welcomeMessage','Hi! How can I help?')}","bot")
                elif kind=="reloaded":
                    self.info.config(text=self._info_text())
                    self.set_status("data reloaded" + (" & re-embedded" if self.connected else ""), ok=True)
                    self.reloadBtn.config(state="normal")
                elif kind=="cerror":
                    self.set_status("error: "+payload[:70]); self.connectBtn.config(state="normal"); self.reloadBtn.config(state="normal")
                elif kind in ("reply","rerror"):
                    if self.thinking: self.thinking.destroy(); self.thinking=None
                    self.set_status("connected — start chatting", ok=True)
                    self.entry.config(state="normal"); self.sendBtn.config(state="normal"); self.entry.focus()
                    if kind=="rerror":
                        self.add_bubble("⚠️ "+payload,"bot")
                    else:
                        res=payload
                        self.add_bubble(f"{PERSONA.get('assistantName','Assistant')}: {res['reply']}","bot")
                        self.add_product_cards(res.get("products") or [])
                        self.history.append({"role":"assistant","content":res["reply"]})
                        self.summary = res.get("_summary", self.summary)     # keep the rolling summary
                        self.show_steps(res.get("steps",[]),res.get("path","?"))
                        self.highlight(res.get("path"))
        except queue.Empty:
            pass
        self.root.after(80,self.pump)

if __name__=="__main__":
    root=tk.Tk(); App(root); root.mainloop()
