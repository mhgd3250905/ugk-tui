import fs from "node:fs";
import path from "node:path";
import { readSettingsJson, resolveSettingsPath, updateSettingsJson, type SettingsIoDeps } from "./settings-io.ts";

export const SUPPORTED_UI_LANGUAGES = [
	{ code: "zh-CN", label: "简体中文", aliases: ["zh", "zh-cn", "cn", "chinese", "中文", "简体中文"] },
	{ code: "en-US", label: "English", aliases: ["en", "en-us", "english", "英文"] },
	{ code: "ja-JP", label: "日本語", aliases: ["ja", "ja-jp", "japanese", "日本語", "日语", "日文"] },
	{ code: "ko-KR", label: "한국어", aliases: ["ko", "ko-kr", "korean", "한국어", "韩语", "韓國語"] },
	{ code: "fr-FR", label: "Français", aliases: ["fr", "fr-fr", "french", "français", "francais", "法语"] },
	{ code: "de-DE", label: "Deutsch", aliases: ["de", "de-de", "german", "deutsch", "德语"] },
	{ code: "es-ES", label: "Español", aliases: ["es", "es-es", "spanish", "español", "espanol", "西班牙语"] },
	{ code: "pt-BR", label: "Português", aliases: ["pt", "pt-br", "portuguese", "português", "portugues", "葡萄牙语"] },
	{ code: "ru-RU", label: "Русский", aliases: ["ru", "ru-ru", "russian", "русский", "俄语"] },
] as const;

export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number]["code"];

const UI_LANGUAGE_KEY = "uiLanguage";
const TRANSLATIONS: Record<string, Partial<Record<UiLanguage, string>>> = {
	"查看状态": { "ja-JP": "状態を表示", "ko-KR": "상태 보기", "fr-FR": "Voir l'état", "de-DE": "Status anzeigen", "es-ES": "Ver estado", "pt-BR": "Ver status", "ru-RU": "Показать статус" },
	"开启": { "ja-JP": "オン", "ko-KR": "켜기", "fr-FR": "Activer", "de-DE": "Einschalten", "es-ES": "Activar", "pt-BR": "Ativar", "ru-RU": "Включить" },
	"关闭": { "ja-JP": "オフ", "ko-KR": "끄기", "fr-FR": "Désactiver", "de-DE": "Ausschalten", "es-ES": "Desactivar", "pt-BR": "Desativar", "ru-RU": "Выключить" },
	"清除": { "ja-JP": "クリア", "ko-KR": "지우기", "fr-FR": "Effacer", "de-DE": "Löschen", "es-ES": "Borrar", "pt-BR": "Limpar", "ru-RU": "Очистить" },
	"退出": { "ja-JP": "終了", "ko-KR": "종료", "fr-FR": "Quitter", "de-DE": "Beenden", "es-ES": "Salir", "pt-BR": "Sair", "ru-RU": "Выйти" },
	"返回": { "ja-JP": "戻る", "ko-KR": "뒤로", "fr-FR": "Retour", "de-DE": "Zurück", "es-ES": "Volver", "pt-BR": "Voltar", "ru-RU": "Назад" },
	"设置界面语言": { "ja-JP": "UI 言語を設定", "ko-KR": "UI 언어 설정", "fr-FR": "Définir la langue de l'UI", "de-DE": "UI-Sprache festlegen", "es-ES": "Definir idioma de la UI", "pt-BR": "Definir idioma da UI", "ru-RU": "Выбрать язык интерфейса" },
	"设置回答语言": { "ja-JP": "返信言語を設定", "ko-KR": "응답 언어 설정", "fr-FR": "Définir la langue de réponse", "de-DE": "Antwortsprache festlegen", "es-ES": "Definir idioma de respuesta", "pt-BR": "Definir idioma de resposta", "ru-RU": "Выбрать язык ответов" },
	"自动放行": { "ja-JP": "自動承認", "ko-KR": "자동 승인", "fr-FR": "Approbation automatique", "de-DE": "Autopilot", "es-ES": "Aprobación automática", "pt-BR": "Aprovação automática", "ru-RU": "Автоподтверждение" },
	"回答语言": { "ja-JP": "返信言語", "ko-KR": "응답 언어", "fr-FR": "Langue de réponse", "de-DE": "Antwortsprache", "es-ES": "Idioma de respuesta", "pt-BR": "Idioma de resposta", "ru-RU": "Язык ответов" },
	"界面语言": { "ja-JP": "UI 言語", "ko-KR": "UI 언어", "fr-FR": "Langue de l'UI", "de-DE": "UI-Sprache", "es-ES": "Idioma de la UI", "pt-BR": "Idioma da UI", "ru-RU": "Язык интерфейса" },
	"选择界面语言": { "ja-JP": "UI 言語を選択", "ko-KR": "UI 언어 선택", "fr-FR": "Choisir la langue de l'UI", "de-DE": "UI-Sprache auswählen", "es-ES": "Elegir idioma de la UI", "pt-BR": "Escolher idioma da UI", "ru-RU": "Выберите язык интерфейса" },
	"界面语言已设为": { "ja-JP": "UI 言語を設定しました", "ko-KR": "UI 언어 설정됨", "fr-FR": "Langue de l'UI définie", "de-DE": "UI-Sprache gesetzt", "es-ES": "Idioma de la UI definido", "pt-BR": "Idioma da UI definido", "ru-RU": "Язык интерфейса установлен" },
	"当前界面语言": { "ja-JP": "現在の UI 言語", "ko-KR": "현재 UI 언어", "fr-FR": "Langue actuelle de l'UI", "de-DE": "Aktuelle UI-Sprache", "es-ES": "Idioma actual de la UI", "pt-BR": "Idioma atual da UI", "ru-RU": "Текущий язык интерфейса" },

	"未选择模型": { "ja-JP": "モデル未選択", "ko-KR": "모델 선택 안 됨", "fr-FR": "modèle non sélectionné", "de-DE": "kein Modell ausgewählt", "es-ES": "modelo no seleccionado", "pt-BR": "modelo não selecionado", "ru-RU": "модель не выбрана" },
	"工作区": { "ja-JP": "ワークスペース", "ko-KR": "작업공간", "fr-FR": "Espace de travail", "de-DE": "Arbeitsbereich", "es-ES": "Espacio de trabajo", "pt-BR": "Área de trabalho", "ru-RU": "Рабочая область" },
	"代理": { "ja-JP": "エージェント", "ko-KR": "에이전트", "fr-FR": "Agent", "de-DE": "Agent", "es-ES": "Agente", "pt-BR": "Agente", "ru-RU": "Агент" },
	"终端编码代理": { "ja-JP": "ターミナル coding agent", "ko-KR": "터미널 coding agent", "fr-FR": "Agent de codage terminal", "de-DE": "Terminal-Coding-Agent", "es-ES": "Agente de código en terminal", "pt-BR": "Agente de código no terminal", "ru-RU": "Терминальный coding agent" },
	"能力": { "ja-JP": "機能", "ko-KR": "기능", "fr-FR": "Capacités", "de-DE": "Funktionen", "es-ES": "Capacidades", "pt-BR": "Recursos", "ru-RU": "Возможности" },
	"快捷操作": { "ja-JP": "クイック操作", "ko-KR": "빠른 작업", "fr-FR": "Actions rapides", "de-DE": "Schnellaktionen", "es-ES": "Acciones rápidas", "pt-BR": "Ações rápidas", "ru-RU": "Быстрые действия" },
	"模型": { "ja-JP": "モデル", "ko-KR": "모델", "fr-FR": "Modèle", "de-DE": "Modell", "es-ES": "Modelo", "pt-BR": "Modelo", "ru-RU": "Модель" },
	"欢迎回来。": { "ja-JP": "おかえりなさい。", "ko-KR": "다시 오신 것을 환영합니다.", "fr-FR": "Bon retour.", "de-DE": "Willkommen zurück.", "es-ES": "Bienvenido de nuevo.", "pt-BR": "Bem-vindo de volta.", "ru-RU": "С возвращением." },
	"◆ 入门提示": { "ja-JP": "◆ はじめに", "ko-KR": "◆ 시작하기", "fr-FR": "◆ Premiers pas", "de-DE": "◆ Erste Schritte", "es-ES": "◆ Primeros pasos", "pt-BR": "◆ Primeiros passos", "ru-RU": "◆ Начало работы" },
	"› /plan      修改前先拟计划": { "ja-JP": "› /plan      編集前に計画", "ko-KR": "› /plan      수정 전 계획", "fr-FR": "› /plan      Planifier avant modification", "de-DE": "› /plan      Vor Änderungen planen", "es-ES": "› /plan      Planificar antes de editar", "pt-BR": "› /plan      Planeje antes de editar", "ru-RU": "› /plan      План перед изменениями" },
	"› /implement 运行引导流程": { "ja-JP": "› /implement ガイド付き実行", "ko-KR": "› /implement 안내 흐름 실행", "fr-FR": "› /implement Lancer le flux guidé", "de-DE": "› /implement Geführten Ablauf starten", "es-ES": "› /implement Ejecutar flujo guiado", "pt-BR": "› /implement Executar fluxo guiado", "ru-RU": "› /implement Запустить сценарий" },
	"› /check-env 检查本地工具": { "ja-JP": "› /check-env ローカルツール確認", "ko-KR": "› /check-env 로컬 도구 확인", "fr-FR": "› /check-env Vérifier les outils locaux", "de-DE": "› /check-env Lokale Tools prüfen", "es-ES": "› /check-env Revisar herramientas locales", "pt-BR": "› /check-env Verificar ferramentas locais", "ru-RU": "› /check-env Проверить локальные инструменты" },
	"◆ 最近更新": { "ja-JP": "◆ 最近の更新", "ko-KR": "◆ 최근 업데이트", "fr-FR": "◆ Mises à jour récentes", "de-DE": "◆ Letzte Updates", "es-ES": "◆ Actualizaciones recientes", "pt-BR": "◆ Atualizações recentes", "ru-RU": "◆ Последние обновления" },
	"› task 显示 worker 进度": { "ja-JP": "› task が worker 進捗を表示", "ko-KR": "› task가 worker 진행률 표시", "fr-FR": "› task affiche la progression worker", "de-DE": "› task zeigt Worker-Fortschritt", "es-ES": "› task muestra progreso del worker", "pt-BR": "› task mostra progresso do worker", "ru-RU": "› task показывает прогресс worker" },
	"› footer 显示用量和就绪状态": { "ja-JP": "› footer が使用量と状態を表示", "ko-KR": "› footer가 사용량과 준비 상태 표시", "fr-FR": "› footer affiche usage et état", "de-DE": "› footer zeigt Nutzung und Bereitschaft", "es-ES": "› footer muestra uso y estado", "pt-BR": "› footer mostra uso e prontidão", "ru-RU": "› footer показывает usage и готовность" },
	"› @agent 委派专注任务": { "ja-JP": "› @agent でタスク委任", "ko-KR": "› @agent로 집중 작업 위임", "fr-FR": "› @agent délègue une tâche ciblée", "de-DE": "› @agent delegiert fokussierte Arbeit", "es-ES": "› @agent delega tareas enfocadas", "pt-BR": "› @agent delega tarefas focadas", "ru-RU": "› @agent делегирует задачу" },

	"模块": { "ja-JP": "モジュール", "ko-KR": "모듈", "fr-FR": "Module", "de-DE": "Modul", "es-ES": "Módulo", "pt-BR": "Módulo", "ru-RU": "Модуль" },
	"状态": { "ja-JP": "状態", "ko-KR": "상태", "fr-FR": "État", "de-DE": "Status", "es-ES": "Estado", "pt-BR": "Status", "ru-RU": "Статус" },
	"检查": { "ja-JP": "チェック", "ko-KR": "검사", "fr-FR": "Vérification", "de-DE": "Prüfung", "es-ES": "Comprobación", "pt-BR": "Verificação", "ru-RU": "Проверка" },
	"结果": { "ja-JP": "結果", "ko-KR": "결과", "fr-FR": "Résultat", "de-DE": "Ergebnis", "es-ES": "Resultado", "pt-BR": "Resultado", "ru-RU": "Результат" },
	"标题": { "ja-JP": "タイトル", "ko-KR": "제목", "fr-FR": "Titre", "de-DE": "Titel", "es-ES": "Título", "pt-BR": "Título", "ru-RU": "Заголовок" },
	"地址": { "ja-JP": "アドレス", "ko-KR": "주소", "fr-FR": "Adresse", "de-DE": "Adresse", "es-ES": "Dirección", "pt-BR": "Endereço", "ru-RU": "Адрес" },
	"连接": { "ja-JP": "接続", "ko-KR": "연결", "fr-FR": "Connexion", "de-DE": "Verbindung", "es-ES": "Conexión", "pt-BR": "Conexão", "ru-RU": "Соединение" },
	"页面": { "ja-JP": "ページ", "ko-KR": "페이지", "fr-FR": "Pages", "de-DE": "Seiten", "es-ES": "Páginas", "pt-BR": "Páginas", "ru-RU": "Страницы" },
	"在线": { "ja-JP": "オンライン", "ko-KR": "온라인", "fr-FR": "En ligne", "de-DE": "Online", "es-ES": "En línea", "pt-BR": "Online", "ru-RU": "В сети" },
	"无法连接": { "ja-JP": "接続不可", "ko-KR": "연결 불가", "fr-FR": "Injoignable", "de-DE": "Nicht erreichbar", "es-ES": "No accesible", "pt-BR": "Inacessível", "ru-RU": "Недоступно" },
	"错误": { "ja-JP": "エラー", "ko-KR": "오류", "fr-FR": "Erreur", "de-DE": "Fehler", "es-ES": "Error", "pt-BR": "Erro", "ru-RU": "Ошибка" },
	"连接失败": { "ja-JP": "接続失敗", "ko-KR": "연결 실패", "fr-FR": "Échec de connexion", "de-DE": "Verbindung fehlgeschlagen", "es-ES": "Conexión fallida", "pt-BR": "Falha na conexão", "ru-RU": "Сбой подключения" },
	"(无标题)": { "ja-JP": "(無題)", "ko-KR": "(제목 없음)", "fr-FR": "(sans titre)", "de-DE": "(ohne Titel)", "es-ES": "(sin título)", "pt-BR": "(sem título)", "ru-RU": "(без заголовка)" },
	"👉 下一步:": { "ja-JP": "👉 次の手順:", "ko-KR": "👉 다음 단계:", "fr-FR": "👉 Étapes suivantes :", "de-DE": "👉 Nächste Schritte:", "es-ES": "👉 Próximos pasos:", "pt-BR": "👉 Próximos passos:", "ru-RU": "👉 Следующие шаги:" },
	"✨ 核心检查全部通过。": { "ja-JP": "✨ コアチェックはすべて成功しました。", "ko-KR": "✨ 핵심 검사를 모두 통과했습니다.", "fr-FR": "✨ Toutes les vérifications principales ont réussi.", "de-DE": "✨ Alle Kernprüfungen bestanden.", "es-ES": "✨ Todas las comprobaciones principales pasaron.", "pt-BR": "✨ Todas as verificações principais passaram.", "ru-RU": "✨ Все основные проверки пройдены." },
};

function withDefaultExists(deps: SettingsIoDeps): SettingsIoDeps {
	return deps.exists ? deps : { ...deps, exists: fs.existsSync };
}

export function normalizeUiLanguage(value: string | undefined): UiLanguage | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	const match = SUPPORTED_UI_LANGUAGES.find((language) => language.aliases.includes(normalized));
	if (match) return match.code;
	return undefined;
}

export function getUiLanguage(deps: SettingsIoDeps = {}): UiLanguage {
	const settings = readSettingsJson(withDefaultExists(deps));
	const value = settings?.[UI_LANGUAGE_KEY];
	return normalizeUiLanguage(typeof value === "string" ? value : undefined) ?? "zh-CN";
}

export function setUiLanguage(language: string, deps: SettingsIoDeps = {}): UiLanguage | undefined {
	const normalized = normalizeUiLanguage(language);
	if (!normalized) return undefined;
	updateSettingsJson({ [UI_LANGUAGE_KEY]: normalized }, withDefaultExists(deps));
	return normalized;
}

export function clearUiLanguage(deps: SettingsIoDeps = {}): void {
	const settings = readSettingsJson(withDefaultExists(deps));
	if (!settings || !(UI_LANGUAGE_KEY in settings)) return;
	delete settings[UI_LANGUAGE_KEY];
	const settingsPath = resolveSettingsPath(deps);
	const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c));
	const mkdir = deps.mkdir ?? ((p: string, o: { recursive: true }) => fs.mkdirSync(p, o));
	mkdir(path.dirname(settingsPath), { recursive: true });
	writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function formatUiLanguage(language: UiLanguage): string {
	return SUPPORTED_UI_LANGUAGES.find((item) => item.code === language)?.label ?? "简体中文";
}

export function uiText<T>(zhCN: T, enUS: T, language: UiLanguage = getUiLanguage()): T {
	if (language === "zh-CN") return zhCN;
	if (language === "en-US") return enUS;
	if (Array.isArray(zhCN) && Array.isArray(enUS)) {
		return zhCN.map((value, index) =>
			typeof value === "string" ? translateString(value, enUS[index] as string | undefined, language) : enUS[index],
		) as T;
	}
	if (typeof zhCN === "string") return translateString(zhCN, enUS as string | undefined, language) as T;
	return enUS;
}

function translateString(zhCN: string, enUS: string | undefined, language: UiLanguage): string {
	return TRANSLATIONS[zhCN]?.[language] ?? enUS ?? zhCN;
}
