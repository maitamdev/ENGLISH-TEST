"use client";

import { useMemo, useState } from "react";
import {
  AudioLines, BookOpenText, BrainCircuit, ChevronDown, Gauge, Headphones,
  MessageCircleMore, Settings2, Sparkles, Swords, UsersRound, Wrench
} from "lucide-react";
import { DEFAULT_MATCH_SETTINGS, MATCH_PRESETS, getMatchPreset } from "@/lib/game/match-presets";
import type { GameGenerationPreferences, MatchSettings } from "@/types/game";

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

type Props = {
  value: GameGenerationPreferences;
  onChange: (value: GameGenerationPreferences) => void;
  disabled?: boolean;
};

export function MatchStudio({ value, onChange, disabled }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selected = useMemo(() => getMatchPreset(value.presetId ?? MATCH_PRESETS[0].id), [value.presetId]);
  const settings = { ...DEFAULT_MATCH_SETTINGS, ...selected.settings, ...(value.settings ?? {}) };

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
      <label><span>Số vòng</span><input type="number" min={5} max={50} value={value.rounds ?? selected.rounds} onChange={(event) => onChange({ ...value, rounds: Math.min(50, Math.max(5, Number(event.target.value))) })} disabled={disabled} /></label>
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
      <div className="toggle-grid">
        <Toggle label="Cân bằng độ khó theo CEFR" checked={settings.adaptiveDifficulty} onChange={(checked) => updateSettings({ adaptiveDifficulty: checked })} />
        <Toggle label="Cho phép gợi ý" checked={settings.allowHints} onChange={(checked) => updateSettings({ allowHints: checked })} />
        <Toggle label="Xáo thứ tự câu" checked={settings.shuffleQuestions} onChange={(checked) => updateSettings({ shuffleQuestions: checked })} />
        <Toggle label="Xáo đáp án trắc nghiệm" checked={settings.shuffleOptions} onChange={(checked) => updateSettings({ shuffleOptions: checked })} />
        <Toggle label="Hiện transcript khi ôn tập" checked={settings.showTranscriptAfter} onChange={(checked) => updateSettings({ showTranscriptAfter: checked })} />
      </div>
    </div>}
  </section>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="studio-toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}
