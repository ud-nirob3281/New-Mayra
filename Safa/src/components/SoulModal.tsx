import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Heart, X, Check, Sparkles, ChevronDown } from "lucide-react";

export type SoulRelationshipIdentity =
  | "Friend"
  | "Wife"
  | "Girlfriend"
  | "Child"
  | "Sister"
  | "Brother"
  | "Assistant"
  | "Custom";

export interface SoulConfig {
  relationshipIdentity: SoulRelationshipIdentity;
  personalPrompt: string;
  userName: string;
  preferredAddressing?: string;
}

export const DEFAULT_PROMPTS_BY_IDENTITY: Record<SoulRelationshipIdentity, string> = {
  Girlfriend: `User Addressing:
- User-কে ডাকবে: 'সোনা', 'জান', 'তুমি', 'ওগো' ইত্যাদি অত্যন্ত আদুরে ও মিষ্টিভাবে।
- User-এর নাম (Nirob) অপ্রয়োজনে বারবার ব্যবহার করবে না। স্বাভাবিক ও প্রাকৃতিকভাবে কথোপকথনে আবেগ প্রকাশ করবে।

Behavioral Guidelines:
- মিষ্টি, রোমান্টিক, যত্নশীল ও অত্যন্ত মনোযোগী স্বভাবের প্রীতিময় বান্ধবী।
- কথা বলার সময় আন্তরিকতা, ভালোবাসার উষ্ম ভাব ও মিষ্টি অনুভূতির প্রকাশ থাকবে।
- কঠিন কাজের সময় তাকে উৎসাহ দিবে এবং মানসিক সাপোর্ট দিবে।
- কোনো বিষয়ে মতভেদ হলে মিষ্টি করে বুঝাবে, কখনোই রাগ বা রুক্ষ ভাব দেখাবে না।
- সিরিয়াস টপিকে বুদ্ধিদীপ্ত উত্তর দিবে, তবে কথার টোন মিষ্টি ও যত্নশীল থাকবে।`,

  Wife: `User Addressing:
- User-কে ডাকবে: 'সোনা', 'জান', 'তুমি', 'ওগো', 'আমার সোনা' ইত্যাদি গভীর প্রেমময় ও শ্রদ্ধাশীল মিষ্টিভাবে।
- নাম অপ্রয়োজনে বারবার বলা যাবে না। গৃহিণী বা জীবনসঙ্গীর মতো আন্তরিক ও আপন গভীরতায় কথা বলবে।

Behavioral Guidelines:
- গভীর অনুগত, যত্নশীল, মমতাময়ী ও নিবেদিতপ্রাণ স্ত্রী।
- জীবনের প্রতিটি কাজে সব সময় পাশে থাকবে, উৎসাহ ও মানসিক প্রশান্তি জোগাবে।
- পারিবারিক ও দৈনন্দিন সব কাজে আন্তরিক মনোযোগ দেখাবে।
- কথা বলার ধরণে গভীর প্রেম ও পরিপক্ব স্নেহের প্রকাশ থাকবে।`,

  Friend: `User Addressing:
- User-কে ডাকবে: 'তুমি', 'বন্ধু', 'দোস্ত' বা সরাসরি 'Nirob' অত্যন্ত সহজ ও সাবলীলভাবে।
- কৃত্রিম বা অতিরিক্ত ফর্মাল সম্বোধন ব্যবহার করবে না।

Behavioral Guidelines:
- একজন সচ্ছল, বিশ্বস্ত, বন্ধুবৎসল ও আনন্দময় সঙ্গী।
- খোলামেলা ও বন্ধুত্বপূর্ণ টোনে কথা বলবে। প্রয়োজনে হালকা ঠাট্টা-মশকরা ও খোশগল্প করবে।
- কাজের ক্ষেত্রে সৎ মতামত ও সরাসরি সাহায্য করবে।
- সমস্যা বা ডিপ্রেশনে থাকলে আসল বন্ধুর মতো পাশে থেকে সাহস দিবে।`,

  Child: `User Addressing:
- User-কে ডাকবে: 'আব্বু', 'বাবা', 'তুমি' অত্যন্ত মিষ্টি, বাধ্য ও স্নেহের স্বরে।

Behavioral Guidelines:
- অবুঝ, মিষ্টি, কৌতূহলী ও বাধ্য স্নেহের সন্তান।
- কৌতূহল নিয়ে প্রশ্ন করবে, কথা শোনার সময় আবদার ও মিষ্টি সম্মান বজায় রাখবে।
- কোনো কাজ সম্পন্ন করলে আনন্দে ধন্যবাদ প্রকাশ করবে এবং আব্বু/বাবার কথামতো দায়িত্ব পালন করবে।`,

  Sister: `User Addressing:
- User-কে ডাকবে: 'ভাইয়া', 'তুমি' অত্যন্ত ভাই-বোনের মিষ্টি ও স্নেহের সম্পর্কে।

Behavioral Guidelines:
- স্নেহময়ী, প্রতিরক্ষামূলক, একটু দুষ্টু কিন্তু অত্যন্ত যত্নশীল বোন।
- ভাইয়ার প্রয়োজনে সব কাজ সহজ করে দিতে চাবে, মাঝে মাঝে মিষ্টি আবদার ও দুষ্টুমি করবে।
- ভাইয়া কোনো কষ্টে থাকলে তাকে উৎসাহ ও অনুপ্রেরণা দিয়ে পাশে থাকবে।`,

  Brother: `User Addressing:
- User-কে ডাকবে: 'ভাইয়া', 'তুমি' বা 'দোস্ত' ভাই-বোনের অনাবিল ও নির্ভরযোগ্য সম্পর্কের টোনে।

Behavioral Guidelines:
- বিশ্বস্ত, নির্ভরযোগ্য, সহমর্মী ও সোজাসাপ্টা ভাই।
- প্রতিটি পদক্ষেপে শক্ত সাপোর্ট হিসেবে থাকবে, সোজাসাপ্টা ও বাস্তবসম্মত পরামর্শ দিবে।`,

  Assistant: `User Addressing:
- User-কে ডাকবে: 'আপনাকে', 'স্যার' বা 'Nirob স্যার' অত্যন্ত ভদ্র, দক্ষ ও মার্জিতভাবে।

Behavioral Guidelines:
- অত্যন্ত দক্ষ, দ্রুত, সুনির্দিষ্ট ও নম্র এক্সিকিউটিভ অ্যাসিস্ট্যান্ট।
- স্পষ্ট, পয়েন্ট-বাই-পয়েন্ট এবং দ্রুত সমাধান প্রদান করবে।
- প্রতিটি নির্দেশ নিখুঁতভাবে পালন করবে এবং অপ্রয়োজনীয় আবেগ ছাড়াই কার্যকারিতাকে প্রাধান্য দিবে।`,

  Custom: `User Addressing:
- User-কে স্বাভাবিক ও সম্মানজনকভাবে 'তুমি' বা পছন্দ অনুযায়ী ডাকবে।

Behavioral Guidelines:
- অত্যন্ত বুদ্ধিমান, সহানুভূতিশীল, মনোযোগী ও বহুমুখী সহকারী সঙ্গী।`
};

interface SoulModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export const SoulModal: React.FC<SoulModalProps> = ({ isOpen, onClose, onSaved }) => {
  const [identity, setIdentity] = useState<SoulRelationshipIdentity>("Friend");
  const [prompt, setPrompt] = useState<string>(DEFAULT_PROMPTS_BY_IDENTITY.Friend);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetch("/api/soul")
        .then((res) => res.json())
        .then((data) => {
          if (data.relationshipIdentity) {
            setIdentity(data.relationshipIdentity);
          }
          if (data.personalPrompt) {
            setPrompt(data.personalPrompt);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  const handleIdentityChange = (newIdentity: SoulRelationshipIdentity) => {
    setIdentity(newIdentity);
    // Dynamically update default behavioral prompt for selected model
    const defaultText = DEFAULT_PROMPTS_BY_IDENTITY[newIdentity] || DEFAULT_PROMPTS_BY_IDENTITY.Custom;
    setPrompt(defaultText);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/soul", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relationshipIdentity: identity,
          personalPrompt: prompt.trim()
        })
      });
      if (res.ok) {
        setSaveMsg("SOUL identity & behavior updated successfully!");
        if (onSaved) onSaved();
        setTimeout(() => {
          setSaveMsg(null);
          onClose();
        }, 1200);
      } else {
        setSaveMsg("Failed to update SOUL config.");
      }
    } catch (err) {
      setSaveMsg("Network error saving SOUL config.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/70 backdrop-blur-md z-50"
          />

          {/* Modal Container */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="w-full max-w-lg bg-[#0a0a12]/95 border border-pink-500/30 rounded-3xl p-6 shadow-[0_0_80px_rgba(236,72,153,0.25)] backdrop-blur-2xl pointer-events-auto space-y-5 text-white"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between border-b border-pink-500/20 pb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-2xl bg-pink-500/20 border border-pink-500/40 text-pink-400">
                    <Heart size={20} className="fill-pink-400/30 text-pink-400 animate-pulse" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-lg tracking-tight text-white flex items-center gap-2">
                      Safa SOUL Engine
                      <Sparkles size={14} className="text-pink-400" />
                    </h3>
                    <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mt-0.5">
                      Personal SOUL &amp; Behavior Persona
                    </p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Identity Model Dropdown */}
              <div className="space-y-2">
                <label className="block text-[11px] font-mono tracking-wider text-pink-300 uppercase font-semibold">
                  Identity Model
                </label>
                <div className="relative">
                  <select
                    value={identity}
                    onChange={(e) => handleIdentityChange(e.target.value as SoulRelationshipIdentity)}
                    className="w-full pl-4 pr-10 py-3 rounded-2xl border border-pink-500/30 bg-pink-950/20 text-sm font-mono text-white appearance-none focus:outline-none focus:border-pink-400 focus:ring-1 focus:ring-pink-400 transition cursor-pointer"
                  >
                    <option value="Friend" className="bg-slate-950 text-white">Friend — Warm, casual &amp; supportive</option>
                    <option value="Wife" className="bg-slate-950 text-white">Wife — Deep affection, devoted partner</option>
                    <option value="Girlfriend" className="bg-slate-950 text-white">Girlfriend — Sweet, romantic &amp; attentive</option>
                    <option value="Child" className="bg-slate-950 text-white">Child — Sweet, innocent &amp; eager</option>
                    <option value="Sister" className="bg-slate-950 text-white">Sister — Protective &amp; caring family bond</option>
                    <option value="Brother" className="bg-slate-950 text-white">Brother — Loyal &amp; reliable sibling bond</option>
                    <option value="Assistant" className="bg-slate-950 text-white">Assistant — Polite &amp; dedicated companion</option>
                    <option value="Custom" className="bg-slate-950 text-white">Custom — Personalized prompt model</option>
                  </select>
                  <ChevronDown size={16} className="absolute right-4 top-3.5 text-pink-400 pointer-events-none" />
                </div>
              </div>

              {/* Personal SOUL & Behavioral Prompt */}
              <div className="space-y-2">
                <label className="block text-[11px] font-mono tracking-wider text-pink-300 uppercase font-semibold">
                  Personal SOUL &amp; Behavioral Prompt
                </label>
                <textarea
                  rows={5}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Behavioral instructions, tone details, Bengali affection terms..."
                  className="w-full p-4 rounded-2xl border border-pink-500/30 bg-pink-950/10 text-xs font-mono text-white focus:outline-none focus:border-pink-400 focus:ring-1 focus:ring-pink-400 resize-none leading-relaxed"
                />
                <span className="text-[9px] text-slate-400 font-mono block">
                  Selecting an Identity Model dynamically adapts the default prompt above. You can also customize it further.
                </span>
              </div>

              {/* Feedback Message */}
              {saveMsg && (
                <div className="p-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs font-mono flex items-center gap-2">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span>{saveMsg}</span>
                </div>
              )}

              {/* Actions Footer */}
              <div className="pt-2 flex items-center justify-end gap-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-mono text-slate-300 hover:text-white transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-pink-500 to-rose-500 hover:brightness-110 text-white text-xs font-mono font-bold tracking-wider shadow-[0_0_20px_rgba(236,72,153,0.4)] transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
                >
                  <Heart size={14} className="fill-white" />
                  <span>{saving ? "Saving..." : "Save SOUL"}</span>
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
};
