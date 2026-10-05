/**
 * The page's words in each language: so far the login page's, the settings
 * page's, the lobby's and the game's buttons. Each is about as long as the
 * English, so the page keeps its shape (the buttons' Russian was measured
 * to keep the phone's rows as the English has them); `{…}` is filled in. A word that goes with a count has a
 * form for each of the language's plural kinds (`Intl.PluralRules`: one,
 * few, many, other), picked by `{n}`.
 *
 * Static texts in index.html say which word they are with `data-word`, and
 * their tooltips and labels with `data-word-title` and `data-word-label`
 * (`translate`); the lobby's How to play and About are written out in each
 * language there instead, as they hold links.
 */

export const WORDS = {
  en: {
    // The login page and the settings page.
    name: 'Your name',
    namePlaceholder: 'Visible name ({max})',
    language: 'Language',
    auto: 'Auto',
    badName: 'Use 1–{max} letters or digits. Spaces and - _ . \' may go between them.',
    refused: 'The server said no ({why}).',
    offline: 'Could not reach the game server.',
    // The login page.
    play: 'Play',
    loading: 'Loading the question…',
    question: 'What is {sum}?',
    noQuestion: 'Could not load the question. Press Play to try again.',
    wrongAnswer: 'That’s not it. Try this one.',
    // The settings page.
    settings: 'Settings',
    back: 'Back',
    save: 'Save',
    // The lobby.
    playingAs: 'Playing as',
    mode: 'Mode',
    players: 'Players',
    newGame: 'New game',
    coopChoice: 'Cooperation: together against the Dark Lord',
    easyChoice: 'Easy Lord: together against a weaker Dark Lord',
    sharedChoice: 'Shared Easy Lord: one stock for all, against a weaker Dark Lord',
    ffaChoice: 'Free for all: each against the other',
    yourGames: 'Your games',
    yourGamesNone: 'None yet. Start one, or join one below.',
    waitingGames: 'Waiting for a player',
    waitingGamesNone: 'No one is waiting right now.',
    ongoingGames: 'Ongoing',
    ongoingGamesNone: 'Nobody else is playing right now.',
    finishedGames: 'Recently finished',
    finishedGamesNone: 'No game has ended yet.',
    howToPlay: 'How to play',
    about: 'About',
    open: 'Open',
    join: 'Join',
    watch: 'Watch',
    scores: 'Scores',
    delete: 'Delete',
    leave: 'Leave',
    deleteTitle: 'Delete it for good: nobody else plays it',
    leaveTitle: 'Give up your seat, for someone else to take',
    askDelete: 'Delete “{game}” for good?',
    askLeave: 'Leave “{game}”? Your seat goes to whoever comes next.',
    deleted: 'Deleted “{game}”.',
    left: 'Left “{game}”.',
    notDeleted: 'Could not delete “{game}” ({why}).',
    notLeft: 'Could not leave “{game}” ({why}).',
    notStarted: 'Could not start a game ({why}).',
    noSuchGame: 'There is no game at that address.',
    notOpened: 'Could not open that game.',
    aGame: 'A game',
    tooMany: 'You have {reasons}. Go back to one of them, or clear one, before starting another:',
    tooManyWaiting: { one: '{n} game of yours waiting for a player', other: '{n} games of yours waiting for a player' },
    tooManySeated: { one: 'a seat in {n} game under way', other: 'a seat in {n} games under way' },
    and: ', and ',
    // A game's mode, by its key in MODES, and how a finished one came out.
    coop: 'Cooperation',
    easy: 'Easy Lord',
    shared: 'Shared Easy Lord',
    ffa: 'Free for all',
    nobodyWon: 'over, nobody won',
    won: 'won',
    lordWon: 'the Dark Lord won',
    sideWon: '{side} won',
    // The players' sides, by their names in SIDES.
    blue: 'Blue',
    crimson: 'Crimson',
    green: 'Green',
    gold: 'Gold',
    teal: 'Teal',
    orange: 'Orange',
    rose: 'Rose',
    silver: 'Silver',
    // The game's buttons. A building's is its name and price ("Tower · 60").
    groupBuild: 'Build',
    groupSelected: 'Selected',
    groupView: 'View',
    tower: 'Tower',
    wagon: 'Wagon',
    pit: 'Pit',
    farm: 'Farm',
    band: 'Band',
    upgrade: 'Upgrade',
    crew: 'Crew…',
    heroes: 'Heroes…',
    return: 'Return',
    abort: 'Abort',
    attack: 'Attack…',
    recenter: 'Recenter',
    mute: 'Mute',
    coordinates: 'Coordinates',
    releaseSeat: 'Release',
    takeSeat: 'Take seat',
    lobby: 'Lobby',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    buildTitle: '{name} ({key}): {price}',
    stoneCost: { one: '{n} stone', other: '{n} stone' },
    metalCost: '{n} dark metal, near your castle',
    hungerCost: '{n}% more hunger (free once it is 100%)',
    free: 'free',
    upgradeTitle: 'Upgrade (U)',
    crewTitle: 'Choose who works here (C)',
    heroesTitle: 'Your heroes, highest level first (H)',
    abortTitle: 'Give up a building still going up: its crew goes home, and its cost is lost',
    attackTitle: 'Attack (A)',
    muteTitle: 'Sounds are on unless this is pressed; your choice is kept in this browser',
    // The keys that press the buttons, each a letter of its label, shown in
    // bold. The English ones work in every language.
    keyTower: 'T',
    keyWagon: 'W',
    keyPit: 'P',
    keyFarm: 'F',
    keyBand: 'B',
    keyUpgrade: 'U',
    keyCrew: 'C',
    keyHeroes: 'H',
    keyAttack: 'A',
  },
  ru: {
    name: 'Ваше имя',
    namePlaceholder: 'Имя в игре ({max})',
    language: 'Язык',
    auto: 'Авто',
    badName: 'От 1 до {max} букв или цифр. Между ними можно пробел и - _ . \'',
    refused: 'Сервер отказал ({why}).',
    offline: 'Нет связи с игровым сервером.',
    play: 'Играть',
    loading: 'Загружаем вопрос…',
    question: 'Сколько будет {sum}?',
    noQuestion: 'Вопрос не загрузился. Нажмите «Играть» ещё раз.',
    wrongAnswer: 'Неверно. Вот другой пример.',
    settings: 'Настройки',
    back: 'Назад',
    save: 'Сохранить',
    playingAs: 'Игрок:',
    mode: 'Режим',
    players: 'Игроки',
    newGame: 'Новая игра',
    coopChoice: 'Кооператив: вместе против Тёмного Лорда',
    easyChoice: 'Лёгкий Лорд: вместе против слабого Тёмного Лорда',
    sharedChoice: 'Общий Лёгкий Лорд: один запас на всех, против слабого Тёмного Лорда',
    ffaChoice: 'Все против всех: каждый сам за себя',
    yourGames: 'Ваши игры',
    yourGamesNone: 'Пока нет. Начните игру или войдите в одну ниже.',
    waitingGames: 'Ждут игрока',
    waitingGamesNone: 'Сейчас никто не ждёт.',
    ongoingGames: 'Идут сейчас',
    ongoingGamesNone: 'Больше никто сейчас не играет.',
    finishedGames: 'Недавно закончились',
    finishedGamesNone: 'Ни одна игра ещё не закончилась.',
    howToPlay: 'Как играть',
    about: 'Об игре',
    open: 'Открыть',
    join: 'Войти',
    watch: 'Смотреть',
    scores: 'Итоги',
    delete: 'Удалить',
    leave: 'Выйти',
    deleteTitle: 'Удалить навсегда: больше никто в неё не играет',
    leaveTitle: 'Освободить своё место для другого игрока',
    askDelete: 'Удалить «{game}» навсегда?',
    askLeave: 'Выйти из «{game}»? Ваше место займёт следующий.',
    deleted: 'Игра «{game}» удалена.',
    left: 'Вы вышли из «{game}».',
    notDeleted: 'Не удалось удалить «{game}» ({why}).',
    notLeft: 'Не удалось выйти из «{game}» ({why}).',
    notStarted: 'Не удалось начать игру ({why}).',
    noSuchGame: 'По этому адресу игры нет.',
    notOpened: 'Не удалось открыть эту игру.',
    aGame: 'Игра',
    tooMany: 'Слишком много игр: {reasons}. Вернитесь в одну из них или уберите одну, чтобы начать новую:',
    tooManyWaiting: {
      one: '{n} ваша ждёт игрока',
      few: '{n} ваши ждут игрока',
      many: '{n} ваших ждут игрока',
      other: '{n} ваших ждут игрока',
    },
    tooManySeated: {
      one: 'вы играете в {n} идущей игре',
      few: 'вы играете в {n} идущих играх',
      many: 'вы играете в {n} идущих играх',
      other: 'вы играете в {n} идущих играх',
    },
    and: ' и ',
    coop: 'Кооператив',
    easy: 'Лёгкий Лорд',
    shared: 'Общий Лёгкий Лорд',
    ffa: 'Все против всех',
    nobodyWon: 'конец, без победителя',
    won: 'победа',
    lordWon: 'победил Тёмный Лорд',
    sideWon: 'победили {side}',
    blue: 'Синие',
    crimson: 'Багровые',
    green: 'Зелёные',
    gold: 'Золотые',
    teal: 'Бирюзовые',
    orange: 'Оранжевые',
    rose: 'Розовые',
    silver: 'Серебряные',
    groupBuild: 'Строить',
    groupSelected: 'Выбрано',
    groupView: 'Вид',
    tower: 'Башня',
    // Воз and Яма, not Повозка and Карьер: with either, Upgrade no longer
    // fits in the phone's first row of buttons, and the second row wraps.
    wagon: 'Воз',
    pit: 'Яма',
    farm: 'Ферма',
    band: 'Отряд',
    // Апгрейд, not Улучшить: it keeps Upgrade in the phone's first row.
    upgrade: 'Апгрейд',
    crew: 'Бригада…',
    heroes: 'Герои…',
    return: 'Вернуть',
    abort: 'Бросить',
    attack: 'Атака…',
    recenter: 'Центр',
    mute: 'Тихо',
    coordinates: 'Координаты',
    releaseSeat: 'Отпусти',
    takeSeat: 'Занять место',
    lobby: 'Лобби',
    zoomOut: 'Отдалить',
    zoomIn: 'Приблизить',
    buildTitle: '{name} ({key}): {price}',
    stoneCost: { one: '{n} камень', few: '{n} камня', many: '{n} камней', other: '{n} камня' },
    metalCost: '{n} тёмного металла, возле вашего замка',
    hungerCost: '+{n}% к голоду (бесплатно при 100%)',
    free: 'бесплатно',
    upgradeTitle: 'Апгрейд (Г)',
    crewTitle: 'Выбрать, кто здесь работает (Д)',
    heroesTitle: 'Ваши герои, сильнейшие первыми (Р)',
    abortTitle: 'Бросить недостроенное здание: бригада идёт домой, затраты пропадают',
    attackTitle: 'Атака (Т)',
    muteTitle: 'Звук включён, пока кнопка не нажата; выбор помнит этот браузер',
    // On the same key as the English one where the word has its letter (Г
    // is on U, Р on H, А on F), else the first letter, else a letter on a key
    // English leaves free (Б and А were taken): never on another button's
    // English key, as those work here too.
    keyTower: 'Б',
    keyWagon: 'В',
    keyPit: 'Я',
    keyFarm: 'А',
    keyBand: 'О',
    keyUpgrade: 'Г',
    keyCrew: 'Д',
    keyHeroes: 'Р',
    keyAttack: 'Т',
  },
};

/** @typedef {keyof typeof WORDS.en} Word */
/** @typedef {{ word: Word, values?: Record<string, string | number> }} Said A text to show, and what fills it in. */

/**
 * A text with its `{placeholders}` filled in; one with no value stays as it is.
 * @param {string} text
 * @param {Record<string, string | number>} [values]
 */
export function fill(text, values = {}) {
  return text.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));
}

/**
 * A text in a language; for a word with plural forms, the one for `{n}`.
 * @param {import('./language.js').PageLanguage} language
 * @param {Said} said
 */
export function say(language, { word, values = {} }) {
  const entry = /** @type {string | Record<string, string>} */ (WORDS[language][word]);
  const text = typeof entry === 'string' ? entry : entry[new Intl.PluralRules(language).select(Number(values.n))] ?? entry.other;
  return fill(text, values);
}

/**
 * Put every element under `root` that names its words in a language: its
 * text (`data-word`), tooltip (`data-word-title`) and label for screen
 * readers (`data-word-label`).
 * @param {ParentNode} root
 * @param {import('./language.js').PageLanguage} language
 */
export function translate(root, language) {
  const word = (/** @type {string | undefined} */ key) => say(language, { word: /** @type {Word} */ (key) });
  for (const element of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-word]'))) {
    element.textContent = word(element.dataset.word);
  }
  for (const element of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-word-title]'))) {
    element.title = word(element.dataset.wordTitle);
  }
  for (const element of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-word-label]'))) {
    element.setAttribute('aria-label', word(element.dataset.wordLabel));
  }
}
