"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AudioLines, BookOpenText, BrainCircuit, ChevronDown, Gauge, Headphones,
  BookmarkPlus, Check, MessageCircleMore, Settings2, Sparkles, Swords, Trash2, UsersRound, Wrench
} from "lucide-react";
import { DEFAULT_MATCH_SETTINGS, MATCH_PRESETS, getMatchPreset } from "@/lib/game/match-presets";
import type { GameGenerationPreferences, MatchSettings, QuestionMode } from "@/types/game";
import { toast } from "sonner";

const skillIcons = {
  Vocabulary: BrainCircuit,
  Listening: Headphones,
  Reading: BookOpenText,
  Speaking: MessageCircleMore,
  Writing: BookOpenText,
  Grammar: Wrench,
  Mixed: Swords,
  "Co-op": UsersRound
};

const modeGroups: { label: string; modes: QuestionMode[] }[] = [
  { label: "Từ vựng", modes: ["VI_TO_EN", "EN_TO_VI", "CONTEXT", "DEFINITION", "COLLOCATION"] },
  { label: "Nghe", modes: ["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING"] },
  { label: "Đọc & ngữ pháp", modes: ["READING", "MULTIPLE_CHOICE", "GRAMMAR", "SENTENCE_BUILDER", "CLOZE", "ERROR_CORRECTION"] },
  { label: "Nói & phát âm", modes: ["PRONUNCIATION", "SHADOWING", "SPEAKING", "ROLEPLAY", "DEBATE"] },
  { label: "Viết", modes: ["WRITING", "TRANSLATION"] }
];

type Props = {
  value: GameGenerationPreferences;
  onChange: (value: GameGenerationPreferences) => void;
  disabled?: boolean;
};

export function MatchStudio({ value, onChange, disabled }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [saved, setSaved] = useState<{ id: string; name: string; description: string | null; configuration: GameGenerationPreferences; is_default: boolean }[]>([]);
  const [saving, setSaving] = useState(false);
  const selected = useMemo(() => getMatchPreset(value.presetId ?? MATCH_PRESETS[0].id), [value.presetId]);
  const settings = { ...DEFAULT_MATCH_SETTINGS, ...selected.settings, ...(value.settings ?? {}) };

  useEffect(() => {
    let active = true;
    void fetch("/api/arena-presets", { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (active && response.ok) setSaved(body.presets ?? []);
    });
    return () => { active = false; };
  }, []);

  function choosePreset(id: string) {
    const preset = getMatchPreset(id);
    onChange({
      ...value,
      presetId: preset.id,
      rounds: preset.rounds,
      timePerQuestion: preset.timePerQuestion,
      modes: preset.modes,
      settings: { ...DEFAULT_MATCH_SETTINGS, ...preset.settings }
    });
  }

  function updateSettings(patch: Partial<MatchSettings>) {
    onChange({ ...value, settings: { ...settings, ...patch } });
  }

  function balancedModes(types: QuestionMode[], rounds: number) {
    const counts = new Map(types.map((type) => [type, 0]));
    for (let index = 0; index < rounds; index += 1) counts.set(types[index % types.length], (counts.get(types[index % types.length]) ?? 0) + 1);
    return types.map((type) => ({ type, count: counts.get(type) ?? 0 })).filter((mode) => mode.count > 0);
  }

  function setRounds(rounds: number) {
    const types = (value.modes?.length ? value.modes : selected.modes).map((mode) => mode.type);
    onChange({ ...value, rounds, modes: balancedModes(types, rounds) });
  }

  function toggleMode(mode: QuestionMode) {
    const current = (value.modes?.length ? value.modes : selected.modes).map((item) => item.type);
    const next = current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode];
    if (!next.length) return;
    onChange({ ...value, presetId: undefined, modes: balancedModes(next, value.rounds ?? selected.rounds) });
  }

  async function saveCurrent() {
    if (presetName.trim().length < 2) return;
    setSaving(true);
    try {
      const response = await fetch("/api/arena-presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: presetName, configuration: value, makeDefault: saved.length === 0 }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Không lưu được cấu hình");
      setSaved((items) => [body, ...items]); setPresetName("");
      toast.success("Đã lưu cấu hình arena.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không lưu được cấu hình"); }
    finally { setSaving(false); }
  }

  async function mutateSaved(id: string, action: "make_default" | "delete") {
    const response = await fetch("/api/arena-presets", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); toast.error(body.error ?? "Không cập nhật được preset"); return; }
    setSaved((items) => action === "delete" ? items.filter((item) => item.id !== id) : items.map((item) => ({ ...item, is_default: item.id === id })));
  }

  return <section className="match-studio" aria-label="Tùy chỉnh trận đấu">
    <div className="studio-heading">
      <div><span className="eyebrow"><Sparkles size={14} /> MATCH STUDIO</span><h2>Chọn cách hai bạn muốn học</h2></div>
      <span className="studio-summary">{value.rounds ?? selected.rounds} vòng · {value.timePerQuestion ?? selected.timePerQuestion}s</span>
    </div>

    <div className="preset-rail" aria-label="Kiểu trận">
      {MATCH_PRESETS.map((preset) => {
        const Icon = skillIcons[preset.skill];
        const active = preset.id === selected.id;
        return <button key={preset.id} type="button" className={`preset-option ${active ? "active" : ""}`} onClick={() => choosePreset(preset.id)} disabled={disabled} aria-pressed={active}>
          <Icon size={19} /><span><strong>{preset.label}</strong><small>{preset.description}</small></span>
        </button>;
      })}
    </div>

    <div className="studio-quick-settings">
      <label><span>Trình độ</span><select value={value.level ?? "Mixed"} onChange={(event) => onChange({ ...value, level: event.target.value as GameGenerationPreferences["level"] })} disabled={disabled}>{["A1","A2","B1","B2","C1","C2","Mixed"].map((level) => <option key={level}>{level}</option>)}</select></label>
      <label><span>Số vòng</span><input type="number" min={5} max={50} value={value.rounds ?? selected.rounds} onChange={(event) => setRounds(Math.min(50, Math.max(5, Number(event.target.value))))} disabled={disabled} /></label>
      <label><span>Thời gian</span><select value={value.timePerQuestion ?? selected.timePerQuestion} onChange={(event) => onChange({ ...value, timePerQuestion: Number(event.target.value) })} disabled={disabled}>{[20,30,40,45,50,60,65,75,90,120].map((time) => <option value={time} key={time}>{time} giây</option>)}</select></label>
      <label><span>Độ khó</span><select value={value.difficulty ?? "Medium"} onChange={(event) => onChange({ ...value, difficulty: event.target.value as GameGenerationPreferences["difficulty"] })} disabled={disabled}>{["Easy","Medium","Hard"].map((difficulty) => <option key={difficulty}>{difficulty}</option>)}</select></label>
    </div>

    <button className="advanced-trigger" type="button" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
      <Settings2 size={17} /> Cài đặt nâng cao <ChevronDown size={16} className={advancedOpen ? "rotated" : ""} />
    </button>

    {advancedOpen && <div className="studio-advanced">
      <fieldset><legend><UsersRound size={16} /> Cách chơi</legend><div className="segmented-control">{([['DUEL','Đối kháng'],['COOP','Cùng đội'],['PRACTICE','Luyện tập']] as const).map(([id,label]) => <button type="button" key={id} className={settings.experience === id ? "active" : ""} onClick={() => updateSettings({ experience: id })}>{label}</button>)}</div></fieldset>
      <fieldset><legend><BrainCircuit size={16} /> Mức chủ động của AI</legend><div className="segmented-control">{([['QUIET','Yên lặng'],['BALANCED','Cân bằng'],['ACTIVE','Chủ động']] as const).map(([id,label]) => <button type="button" key={id} className={settings.aiPresence === id ? "active" : ""} onClick={() => updateSettings({ aiPresence: id })}>{label}</button>)}</div></fieldset>
      <fieldset><legend><Gauge size={16} /> Chấm đáp án</legend><div className="segmented-control">{([['LENIENT','Thoáng'],['STANDARD','Chuẩn'],['STRICT','Khắt khe']] as const).map(([id,label]) => <button type="button" key={id} className={settings.strictness === id ? "active" : ""} onClick={() => updateSettings({ strictness: id })}>{label}</button>)}</div></fieldset>
      <fieldset><legend><AudioLines size={16} /> Listening Lab</legend><div className="inline-fields"><label><span>Giọng</span><select value={settings.listeningAccent} onChange={(event) => updateSettings({ listeningAccent: event.target.value as MatchSettings["listeningAccent"] })}><option value="US">Mỹ</option><option value="UK">Anh</option><option value="AU">Úc</option></select></label><label><span>Tốc độ</span><select value={settings.listeningSpeed} onChange={(event) => updateSettings({ listeningSpeed: Number(event.target.value) as MatchSettings["listeningSpeed"] })}><option value="0.75">0.75x</option><option value="1">1x</option><option value="1.25">1.25x</option></select></label><label><span>Số lần nghe</span><input type="number" min={1} max={5} value={settings.replayLimit} onChange={(event) => updateSettings({ replayLimit: Number(event.target.value) })} /></label><label><span>Nội dung</span><select value={settings.listeningFocus} onChange={(event) => updateSettings({ listeningFocus: event.target.value as MatchSettings["listeningFocus"] })}><option value="WORDS">Từ và âm</option><option value="SENTENCES">Câu</option><option value="STORIES">Câu chuyện</option><option value="MIXED">Hỗn hợp</option></select></label></div></fieldset>
      <fieldset><legend><MessageCircleMore size={16} /> Thi nói</legend><div className="inline-fields"><label><span>Nói tự do</span><select value={settings.speakingSeconds} onChange={(event) => updateSettings({ speakingSeconds: Number(event.target.value) })}>{[30,45,60,90,120].map((value) => <option value={value} key={value}>{value} giây</option>)}</select></label><label><span>Shadowing</span><select value={settings.shadowingSeconds} onChange={(event) => updateSettings({ shadowingSeconds: Number(event.target.value) })}>{[15,20,30,45,60].map((value) => <option value={value} key={value}>{value} giây</option>)}</select></label></div></fieldset>
      <fieldset><legend><BrainCircuit size={16} /> Điều phối thích ứng</legend><div className="inline-fields"><label><span>Thứ tự câu</span><select value={settings.sequencingPolicy} onChange={(event) => updateSettings({ sequencingPolicy: event.target.value as MatchSettings["sequencingPolicy"] })}><option value="BALANCED">Cân bằng mode</option><option value="WEAKNESS_FIRST">Ưu tiên điểm yếu</option><option value="SPACED_RETRIEVAL">Ưu tiên FSRS đến hạn</option></select></label><label><span>Đường độ khó</span><select value={settings.difficultyCurve} onChange={(event) => updateSettings({ difficultyCurve: event.target.value as MatchSettings["difficultyCurve"] })}><option value="ADAPTIVE">Theo mastery</option><option value="RAMP_UP">Tăng dần</option><option value="STEADY">Ổn định</option></select></label><label><span>Sau trận</span><select value={settings.remediationPolicy} onChange={(event) => updateSettings({ remediationPolicy: event.target.value as MatchSettings["remediationPolicy"] })}><option value="AUTO">Lỗi + hint + recall chậm</option><option value="WRONG_ONLY">Chỉ câu sai</option><option value="OFF">Không tạo remediation</option></select></label><label><span>Fairness</span><select value={settings.fairnessMode} onChange={(event) => updateSettings({ fairnessMode: event.target.value as MatchSettings["fairnessMode"] })}><option value="STANDARD">Tiêu chuẩn</option><option value="STRICT">Chặt độ trễ</option></select></label></div></fieldset>
      <fieldset className="mode-mixer"><legend><Swords size={16} /> Mode mixer</legend><p>Chọn bất kỳ kỹ năng nào; số câu được cân lại theo tổng số vòng.</p>{modeGroups.map((group) => <div key={group.label}><strong>{group.label}</strong><div>{group.modes.map((mode) => { const active = (value.modes ?? selected.modes).some((item) => item.type === mode); return <button type="button" key={mode} className={active ? "active" : ""} aria-pressed={active} onClick={() => toggleMode(mode)}>{mode.replaceAll("_", " ")}</button>; })}</div></div>)}</fieldset>
      <div className="toggle-grid">
        <Toggle label="Cân bằng độ khó theo CEFR" checked={settings.adaptiveDifficulty} onChange={(checked) => updateSettings({ adaptiveDifficulty: checked })} />
        <Toggle label="Cho phép gợi ý" checked={settings.allowHints} onChange={(checked) => updateSettings({ allowHints: checked })} />
        <Toggle label="Xáo thứ tự câu" checked={settings.shuffleQuestions} onChange={(checked) => updateSettings({ shuffleQuestions: checked })} />
        <Toggle label="Xáo đáp án trắc nghiệm" checked={settings.shuffleOptions} onChange={(checked) => updateSettings({ shuffleOptions: checked })} />
        <Toggle label="Hiện transcript khi ôn tập" checked={settings.showTranscriptAfter} onChange={(checked) => updateSettings({ showTranscriptAfter: checked })} />
        <Toggle label="Bắt buộc kiểm tra audio cho trận nghe/nói" checked={settings.requireAudioPreflight} onChange={(checked) => updateSettings({ requireAudioPreflight: checked })} />
      </div>
      <div className="saved-preset-studio"><div><strong>Cấu hình của tôi</strong><span>Lưu thiết lập thật vào tài khoản để dùng lại ở phòng khác.</span></div><div className="saved-preset-create"><input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Tên cấu hình" maxLength={80} /><button type="button" className="button button-secondary" onClick={() => void saveCurrent()} disabled={saving || presetName.trim().length < 2}><BookmarkPlus size={15} /> Lưu</button></div>{saved.length > 0 && <div className="saved-preset-list">{saved.map((item) => <div key={item.id}><button type="button" onClick={() => onChange(item.configuration)} disabled={disabled}><span>{item.name}</span>{item.is_default && <small><Check size={12} /> mặc định</small>}</button><button type="button" aria-label={`Đặt ${item.name} làm mặc định`} onClick={() => void mutateSaved(item.id, "make_default")} disabled={item.is_default}><Check size={14} /></button><button type="button" aria-label={`Xóa ${item.name}`} onClick={() => void mutateSaved(item.id, "delete")}><Trash2 size={14} /></button></div>)}</div>}</div>
    </div>}
  </section>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="studio-toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}
