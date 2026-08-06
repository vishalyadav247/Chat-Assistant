"""
prompts.py — tiny loader. All the actual instruction TEXT lives in prompts.json.

Edit prompts.json (simple, one line per rule) to change the assistant's behaviour;
this file just loads it and exposes the same names the app imports. Lists in the
JSON are joined into a single instruction string.
"""
import os, json

_HERE = os.path.dirname(os.path.abspath(__file__))
_P = json.load(open(os.path.join(_HERE, "prompts.json"), encoding="utf-8"))

def _s(v):
    return " ".join(v) if isinstance(v, list) else v

# fixed pipeline instructions
ROUTER              = _s(_P["router"])
SUMMARY_SYS         = _s(_P["summary_system"])
CHAT_REPLY          = _s(_P["chat_reply"])
QUESTION_ANSWER     = _s(_P["question_answer"])
PRODUCT_RECOMMEND   = _s(_P["product_recommend"])
CURATED_CONFIRM_SYS = _s(_P["curated_confirm_system"])

def curated_confirm_user(msg, question):
    return _P["curated_confirm_user"].format(question=question, msg=msg)

def build_system_prompt(persona):
    p = persona
    return _P["persona_template"].format(
        role=p.get("role", ""),
        brand_voice=p.get("brandVoice", ""),
        guidelines="; ".join(p.get("guidelines", [])),
        avoid="; ".join(p.get("avoid", [])),
    )
