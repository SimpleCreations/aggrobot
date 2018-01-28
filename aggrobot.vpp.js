// ==VPPScript==
// @name            AggroBot
// @version         1.0.0
// @script-filename aggrobot.vpp.js
// @update-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/Release-2/update.json
// @script-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/master/aggrobot.vpp.js
// @database-url    https://raw.githubusercontent.com/SimpleCreations/aggrobot/Release-2/database.json
// ==/VPPScript==

const log = message => VPP.chats[0].log(`[AggroBot] ${message}`);

const compareVersions = (version1, version2) => {
    version1 = version1.split(".");
    version2 = version2.split(".");
    for (let i = 0; i < version2.length; i++) {
        if (!version1[i] || +version2[i] > +version1[i]) return 1;
        else if (+version2[i] < +version1[i]) return -1;
    }
    return version2.length != version1.length ? -1 : 0;
};

log("Проверка обновлений...");
$.ajax({
    url: VPPScript.meta["update-url"],
    dataType: "json",
    cache: false
})
    .pipe(response => response["script_version"] ? response : $.Deferred().reject())
    .done(response => {

        log(compareVersions(response["script_version"], VPPScript.meta["version"]) < 0 ?

            `Вы используете устаревший скрипт.<br>
Текущая версия: ${VPPScript.meta["version"]}<br>
Последняя версия: ${response["script_version"]}<br>
Введите "/aggrobot download", чтобы скачать последнюю версию.` :

            `Вы используете последнюю версию скрипта.`

        );

        if (!response["database_version"]) return log("Не удалось получить последнюю версию базы сообщений.");
        const currentDatabaseVersion = VPPScript.storage.databaseVersion;
        if (!currentDatabaseVersion || compareVersions(response["database_version"], currentDatabaseVersion) < 0) {

            log(!currentDatabaseVersion ? "Идёт скачивание базы сообщений..." : "Идёт обновление базы сообщений...");
            $.ajax({
                url: VPPScript.meta["database-url"],
                dataType: "json",
                cache: false
            })
                .done(database => {
                    VPPScript.storage.database = database;
                    VPPScript.storage.databaseVersion = response["database_version"];
                    VPPScript.storage.save();
                    log("База сообщений успешно " + (!currentDatabaseVersion ? "загружена." : "обновлена."));
                    enableScript();
                })
                .fail(() => {
                    log("Не удалось скачать базу сообщений.");
                    if (currentDatabaseVersion) enableScript();
                });

            VPP.chats.forEach(chat =>
                chat.addEventListener(VPP.Chat.Event.CONNECTED, "aggrobot", () =>
                    chat.log("[AggroBot] Скрипт начнёт работу только по завершении загрузки базы сообщений.")));

        }
        else enableScript();

    })
    .fail(() => log("Не удалось получить данные об обновлении."));

const enableScript = () => {

    let firstDatabase = null;
    VPP.chats.forEach(chat => {

        const aggroBot = new AggroBot();
        chat.aggroBot = aggroBot;
        const database = !firstDatabase ? (firstDatabase = AggroBot.Database.fromRaw(VPPScript.storage.database)) :
            AggroBot.Database.fromAnother(firstDatabase);
        aggroBot.setDatabase(database);
        aggroBot.onTypingStart = () => chat.isChatStarted() && chat.setStartedTyping();
        aggroBot.onTypingFinish = () => chat.isChatStarted() && chat.setFinishedTyping();
        aggroBot.onMessageReady = message => chat.isChatStarted() && chat.sendMessage(message);
        aggroBot.onConversationFinish = () => chat.isChatStarted() && chat.close();
        aggroBot.onReport = message => chat.log(message);

        chat.removeEventListener("aggrobot");
        chat.addEventListener(VPP.Chat.Event.CONNECTED, "aggrobot", () => {

            // Генерируем новое состояние бота и готовим приветственное сообщение
            aggroBot.reset();
            aggroBot.prepareResponse();

        });

        chat.addEventListener(VPP.Chat.Event.MESSAGE_RECEIVED, "aggrobot", (type, content) => {

            const text = type === VPP.Chat.MessageType.TEXT ? content : "";
            aggroBot.receiveMessage(text);
            aggroBot.prepareResponse(text);

        });

        chat.addEventListener(VPP.Chat.Event.USER_STARTED_TYPING, "aggrobot", () => {

            // Если собеседник начал печатать во время ответа бота, бот на короткое время "отвлекается" от набора текста
            aggroBot.waitForOpponent();

        });

        chat.addEventListener(VPP.Chat.Event.DISCONNECTED, "aggrobot", () => {

            chat.setFinishedTyping();
            aggroBot.suspend();

        });

    });

};

const AggroBot = class {

    /**
     * Генерирует новое состояние бота
     */
    reset() {

        this.suspend();

        if (this._database) this._database.reset();

        /**
         * ID таймеров различных откладываемых действий
         * @type {number}
         * @private
         */
        this._readTimeout = null;
        this._typeTimeout = null;
        this._interruptedTimeout = null;
        this._activityCheckTimeout = null;

        /**
         * Счётчик тиков неактивности собеседника
         * @type {number}
         * @private
         */
        this._inactivityCounter = 0;

        /**
         * Timestamp, когда бот начал печать ответа.
         * Вспомогательное свойство.
         * @type {number}
         * @private
         */
        this._typingStartedTime = null;

        /**
         * Очередь ответов бота
         * @type {Array<AggroBot.QueuedResponse>}
         * @private
         */
        this._responseQueue = [];

        /**
         * Было ли отправлено приветственное сообщение
         * @type {boolean}
         * @private
         */
        this._greeted = false;

        /**
         * Установлено в true, если бот ещё не писал сообщение с момента получения последнего сообщения от собеседника
         * @type {boolean}
         * @private
         */
        this._directResponse = false;

        /**
         * Информация о пользователе
         * @type {AggroBot.UserProfile}
         * @private
         */
        this._userProfile = new AggroBot.UserProfile();

        /**
         * Стиль письма бота
         * @type {AggroBot.Style}
         * @private
         */
        this._style = new AggroBot.Style();

    }

    /**
     * Устанавливает базу сообщений бота
     * @param {AggroBot.Database} database
     */
    setDatabase(database) {

        this._database = database;

    }

    /**
     * Останавливает работу бота
     */
    suspend() {

        clearTimeout(this._readTimeout);
        this._readTimeout = null;
        clearTimeout(this._typeTimeout);
        this._typeTimeout = null;
        clearTimeout(this._interruptedTimeout);
        this._interruptedTimeout = null;
        clearTimeout(this._activityCheckTimeout);
        this._activityCheckTimeout = null;

    }

    /**
     * Уведомляет бота о том, что ему отослали сообщение
     * @param {string} request Сообщение от собеседника
     */
    receiveMessage(request) {

        // Пытаемся определить пол
        this._determineGender(request);

        // Полученное сообщение считается активностью, поэтому сбрасываем счётчик
        this._inactivityCounter = 0;

        this._directResponse = true;

        // Смотрим, есть ли в очереди ответы, которые должны быть удалены из очереди во время получения сообщения
        let queueUpdated = false;
        if (this._responseQueue[0] && this._responseQueue[0].discardOnMessage) {
            clearTimeout(this._readTimeout);
            clearTimeout(this._typeTimeout);
            clearTimeout(this._interruptedTimeout);
            this._readTimeout = null;
            this._typeTimeout = null;
            this._interruptedTimeout = null;
            this._resetInactiveTimeout();
            queueUpdated = true;
        }
        this._responseQueue = this._responseQueue.filter(queued => !queued.discardOnMessage);
        if (queueUpdated) this._setQueueUpdated();

        // Если бот получил сообщение, пока писал своё, он отвлекается на его прочтение
        const nextQueued = this._responseQueue[0];
        if (nextQueued) {
            if (nextQueued.interruptOnMessage) this._interrupt(AggroBot.getTimeToRead(request));
        }
        else this._resetInactiveTimeout();

    }

    /**
     * Готовит и откладывает ответ собеседнику
     * @param {string} request Сообщение от собеседника
     */
    prepareResponse(request = "") {

        if (!this._greeted) {
            this._greeted = true;
            this._processAndAddToQueue(this._getMessage("greetings"), {
                discardOnMessage: true
            });
        }
        else {
            // Добавляем в очередь новый первичный ответ, если бот не занят
            if (!this._responseQueue[0] || this._responseQueue.every(queued => !queued.blockQueue)) {
                this._processAndAddToQueue(this._getMessage("primary"), {
                    readDelay: AggroBot.getTimeToRead(request)
                });
                while (Math.random() < AggroBot.PROBABILITY_SECONDARY) {
                    this._processAndAddToQueue(this._getMessage("secondary"), {
                        readDelay: AggroBot.TIME_ADDITIONAL_READ_DELAY,
                        interruptOnTyping: false,
                        discardOnMessage: true
                    });
                }
            }
        }

    }

    /**
     * Задерживает ответ
     */
    waitForOpponent() {

        if (this._responseQueue[0]) {
            if (this._responseQueue[0].interruptOnTyping) this._interrupt(AggroBot.TIME_WAIT);
        }
        else this._resetInactiveTimeout();

    }

    /**
     * Вызывается, когда нужно начать посылать уведомление о наборе сообщения
     */
    onTypingStart() {}

    /**
     * Вызывается, когда нужно закончить посылать уведомление о наборе сообщения
     */
    onTypingFinish() {}

    /**
     * Вызывается, когда нужно отправить ответ от бота
     */
    onMessageReady() {}

    /**
     * Вызывается, когда бот инициирует завершение чата
     */
    onConversationFinish() {}

    /**
     * Вызывается, когда бот посылает отчётную информацию
     */
    onReport() {}

    /**
     * Форсирует проверку очереди сообщений
     * @private
     */
    _setQueueUpdated() {

        // Ничего не делаем, если бот уже читает запрос или пишет ответ
        if (this._readTimeout || this._typeTimeout) return;

        // Если очередь не пустая, запускаем таймер чтения последнего сообщения.
        // Иначе запускаем таймер неактивности собеседника.
        const queued = this._responseQueue[0];
        if (queued) this._readTimeout = setTimeout(this._setReadingFinished.bind(this), queued.readDelay);
        else this._resetInactiveTimeout();

    }

    /**
     * Вспомогательный метод, вызываемый, когда чтение (задержка перед набором) текущего сообщения должно быть закончено
     * @private
     */
    _setReadingFinished() {

        this._readTimeout = null;
        this._typingStartedTime = Date.now();
        this.onTypingStart();
        this._typeTimeout = setTimeout(this._setTypingFinished.bind(this), this._responseQueue[0].typeDelay);

    }

    /**
     * Вспомогательный метод, вызываемый, когда набор текущего сообщения должен быть закончен
     * @private
     */
    _setTypingFinished() {

        this._typeTimeout = null;
        this.onTypingFinish();
        this.onMessageReady(this._responseQueue.shift().message);
        this._directResponse = false;
        this._setQueueUpdated();

    }

    /**
     * Запускает таймер, который, если во время его активности собеседник не был активен, увеличивает счётчик тиков
     * неактивности.
     * При каждом прибавлении бот выполняет действия, направленные на привлечение внимания собеседника.
     * Если собеседник неактивен несколько тиков подряд, соединение разрывается.
     * @private
     */
    _resetInactiveTimeout() {

        clearTimeout(this._activityCheckTimeout);
        this._activityCheckTimeout = setTimeout(() => {
            this._activityCheckTimeout = null;
            switch (++this._inactivityCounter) {
                case 1:
                    this.prepareResponse();
                    break;
                case 2:
                case 3:
                    this._processAndAddToQueue(this._getMessage("inactivity_response"), {
                        discardOnMessage: true
                    });
                    break;
                default:
                    this.onConversationFinish();
            }
        }, AggroBot.TIME_INCREMENT_INACTIVE_COUNTER);

    }

    /**
     * Добавляет ответ в очередь
     * @param {AggroBot.QueuedResponse} queued
     * @private
     */
    _enqueueResponse(queued) {

        this._responseQueue.push(queued);
        this._setQueueUpdated();

    }

    /**
     * Очищает очередь
     * @private
     */
    _clearQueue() {

        clearTimeout(this._readTimeout);
        this._readTimeout = null;
        clearTimeout(this._typeTimeout);
        this._typeTimeout = null;
        clearTimeout(this._interruptedTimeout);
        this._interruptedTimeout = null;

        this._responseQueue.length = 0;
        this._setQueueUpdated();

    }

    /**
     * Задерживает/прерывает/отвлекает бота от чтения/печати на время
     * @param {number} time Время, мс
     * @private
     */
    _interrupt(time) {

        if (!this._readTimeout && !this._typeTimeout) return;

        // Если в данный момент активно чтение, то чтение будет закончено по истечение переданного времени
        if (this._readTimeout) {
            clearTimeout(this._readTimeout);
            this._readTimeout = setTimeout(this._setReadingFinished.bind(this), time);
        }

        // Если же активна печать, то статус печати перестаёт отправляться на переданное время
        else if (this._typeTimeout) {
            clearTimeout(this._typeTimeout);
            this._typeTimeout = null;
            this.onTypingFinish();
            const delayLeft = this._responseQueue[0].typeDelay - (Date.now() - this._typingStartedTime);
            this._interruptedTimeout = setTimeout(() => {
                this._interruptedTimeout = null;
                this._responseQueue[0].typeDelay = delayLeft;
                this.onTypingStart();
                this._typeTimeout = setTimeout(this._setTypingFinished.bind(this), delayLeft);
            }, time);
        }

    }

    /**
     * Возвращает случайное сообщение из базы сообщений по ключу
     * @param {string} databaseKey
     * @returns {string}
     * @private
     */
    _getMessage(databaseKey) {

        // Парсим функции и флаги внутри сообщения
        // Временно: удаляем $
        let retry = false;
        let message = this._database.getRandom(databaseKey).string;
        message = message.replace(/%(\w+)(?:\(([^,)]*(?:,[^,)]*)*)\))?/g, (_, name, args) => {

            args = args ? args.split(",") : [];

            switch (name) {
                case "g":
                case "gender":
                    if (!args.length) {
                        const genderName = this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ?
                            ["мужик", "пацан", "парень"] : ["баба", "телка", "девушка"];
                        return genderName[Math.floor(Math.random() * genderName.length)];
                    }
                    return (this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ? args[0] : args[1]) || "";
                case "d":
                case "direct":
                    if (!this._directResponse) retry = true;
                    break;
                case "nd":
                case "nondirect":
                    if (this._directResponse) retry = true;
                    break;
            }

            return "";

        }).replace(/[$@]\w+/g, "");

        if (retry) return this._getMessage(databaseKey);
        return message;

    }

    /**
     * Обрабатывает сообщение из базы сообщений и добавляет все полученные ответы в очередь
     * @param {string} message
     * @param {object} queuedResponseOptions Дополнительные параметры и флаги для ответа в очереди
     * @private
     */
    _processAndAddToQueue(message, queuedResponseOptions = {}) {

        this._prepareQueuedResponses(message, queuedResponseOptions).forEach(queued => this._enqueueResponse(queued));

    }

    /**
     * Обрабатывает сообщение из базы сообщений и возвращает все ответы, которые необходимо добавить в очередь
     * @param {string} message
     * @param {object} queuedResponseOptions Дополнительные параметры и флаги для ответа в очереди
     * @returns {Array<AggroBot.QueuedResponse>}
     * @private
     */
    _prepareQueuedResponses(message, queuedResponseOptions = {}) {

        // Добавляем в конец фразы слово из набора addition
        if (!/\?$/.test(message) && Math.random() < this._style.additionProbability) {
            message += (Math.random() < this._style.additionLineBreakProbability ? " // " : " ") +
                this._getMessage("addition");
        }

        // Обрабатываем разбиения
        const splitResult = [];
        message.split(" // ").forEach(part => {
            const push = response => {
                const queued = new AggroBot.QueuedResponse(response);
                Object.keys(queuedResponseOptions).forEach(key => queued[key] = queuedResponseOptions[key]);
                splitResult.push(queued);
            };
            let buffer;
            part.split(" / ").forEach(part => {
                if (!buffer) buffer = part;
                else if (Math.random() < AggroBot.getSplitProbabilityByCurrentPart(buffer)) {
                    push(buffer);
                    buffer = part;
                }
                else buffer += " " + part;
            });
            // noinspection JSUnusedAssignment
            push(buffer.trim());
        });

        // Добавляем ошибки
        splitResult.forEach(queued => queued.message = this._style.misspell(queued.message));

        // Умножаем количество вопросительных и восклицательных знаков
        for (let i = splitResult.length - 1; i >= 0; i--) {
            const queued = splitResult[i];
            if (!/[!?]$/.test(queued.message)) continue;
            while (Math.random() < this._style.questionMarkDuplicationProbability) {
                queued.message += queued.message.slice(-1);
            }
            queued.message = queued.message.replace(/[!?]+$/, match => {
                if (Math.random() > this._style.questionMarkLineBreakProbability) return match;
                const marksQueued = new AggroBot.QueuedResponse(match);
                marksQueued.readDelay = AggroBot.TIME_ADDITIONAL_READ_DELAY;
                marksQueued.interruptOnTyping = false;
                marksQueued.interruptOnMessage = false;
                marksQueued.discardOnMessage = !!queuedResponseOptions.discardOnMessage;
                marksQueued.blockQueue = false;
                splitResult.splice(i + 1, 0, marksQueued);
                return "";
            });
        }

        // Вставляем опечатки
        let typosResult = [];
        splitResult.forEach(queued => {
            const {result, corrections} = this._style.insertTypos(queued.message);
            queued.message = result;
            typosResult.push(queued);
            corrections.forEach(correction => {
                const queued = new AggroBot.QueuedResponse(correction + "*");
                queued.readDelay = AggroBot.TIME_ADDITIONAL_READ_DELAY;
                queued.interruptOnTyping = false;
                queued.interruptOnMessage = false;
                queued.discardOnMessage = !!queuedResponseOptions.discardOnMessage;
                queued.blockQueue = false;
                typosResult.push(queued);
            });
            if (corrections.length && Math.random() < AggroBot.getTypoExclamationProbabilityByAmountOfCorrections(corrections.length)) {
                console.log("Adding exclamation");
                this._prepareQueuedResponses(this._getMessage("exclamation"), {
                    readDelay: AggroBot.TIME_ADDITIONAL_READ_DELAY,
                    discardOnMessage: !!queuedResponseOptions.discardOnMessage,
                    interruptOnTyping: false,
                    interruptOnMessage: false,
                    blockQueue: false
                }).forEach(queued => typosResult.push(queued));
            }
        });

        // Добавляем заглавные буквы
        if (this._style.capitalize) typosResult.forEach(queued =>
            queued.message = queued.message[0].toUpperCase() + queued.message.substring(1));

        return typosResult;

    }

    /**
     * Пытается определить пол по сообщению и записать в профиль
     * @param message
     * @private
     */
    _determineGender(message) {

        let gender;
        if (/(^|[^а-яё])(я?([жд]|дев(оч|ч[ео]н|уш)ка|женщина|баба|телка|тянк?а?)|я\s+[а-яё]{3,}ая?)($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|я\s+не\s+([мmп]|парень?|пацан|мальчик|муж(ик|чина)?)($|[^а-яё])|((я|меня)\s+|^)(Александра|Алина|Алиса|Алла|Анастасия|Настя|Анна|Аня|Адель|Валерия|Вера|Виктория|Вика|Галя|Дарья|Даша|Диана|Ева|Евгения|Екатерина|Катя|Елена|Лена|Елизавета|Лиза|Ира|Ирина|Карина|Кира|Кристина|Ксения|Ксюша|Лариса|Лида|Лилия|Люба|Людмила|Люда|Маргарита|Рита|Марина|Мария|Маша|Милена|Надежда|Надя|Наталья|Наташа|Ника|Нина|Оксана|Олеся|Ольга|Оля|Полина|Светлана|Света|Софья|Соня|Татьяна|Таня|Ульяна|Юлия|Юля|Яна)[^а-яё?]/i.test(message)) {
            gender = AggroBot.UserProfile.Gender.FEMALE;
        }
        else if (/(^|[^а-яё])(я?([мmп]|парень?|пацан|мальчик|муж(ик|чина)?)|я\s+[а-яё]{2,}(ый|л))($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|я\s+не\s+([жд]|дев(оч|ч[ео]н|уш)ка|женщина|баба|телка|тянк?а?)($|[^а-яё])|((я|меня)\s+|^)(Александр|Алексей|Леша|Леха|Андрей|Антон|Артем|Артур|Ваня|Василий|Вася|Виктор|Витя|Виталий|Владимир|Вова|Влад|Глеб|Григорий|Гриша|Даниил|Данила|Денис|Дмитрий|Дима|Евгений|Егор|Иван|Игорь|Илья|Кирилл|Костя|Макс|Матвей|Михаил|Миша|Никита|Николай|Коля|Олег|Павел|Паша|Рома|Семен|Сема|Сергей|Стас|Тимур|Юрий|Юра)[^а-яё?]/i.test(message)) {
            gender = AggroBot.UserProfile.Gender.MALE;
        }

        if (gender !== undefined) {
            this.onReport("Определён пол: " + (gender === AggroBot.UserProfile.Gender.MALE ? "мужской" : "женский"));
            if (this._userProfile.gender != gender) {
                this._userProfile.gender = gender;
                if (this._responseQueue.length) this._clearQueue();
            }
        }

    }

};

Object.assign(AggroBot, {

    /**
     * Возвращает время, необходимое для чтения сообщения, мс
     * @param {string} message
     * @returns {number}
     */
    getTimeToRead(message) {
        return 850 + 350 * (message + " ").match(/\s+/g).length;
    },

    /**
     * Возвращает время, необходимое для печати сообщения, мс
     * @param {string} message
     * @returns {number}
     */
    getTimeToType(message) {
        return 500 + 210 * message.length;
    },

    /**
     * Время, на которое бот прерывается, когда замечает, что собеседник печатает, мс
     */
    TIME_WAIT: 4000,

    /**
     * Время, в течение которого бот ждёт пользователя, прежде чем реагировать на его неактивность, мс
     */
    TIME_INCREMENT_INACTIVE_COUNTER: 15000,

    /**
     * Время задержки перед началом печати дополнительного сообщения (части разбиения, вторичной фразы и т.д.)
     */
    TIME_ADDITIONAL_READ_DELAY: 600,

    /**
     * Вероятность написания первичного ответа
     */
    PROBABILITY_SECONDARY: 0.275,

    /**
     * Определяет вероятность вставки междометия после поправки опечатки в зависимости от количества поправок
     * @param {number} amountOfCorrections
     * @returns {number}
     */
    getTypoExclamationProbabilityByAmountOfCorrections(amountOfCorrections) {
        return Math.pow(0.3, 1 / amountOfCorrections);
    },

    /**
     * Возвращает вероятность разбиения сообщения при переданной текущей неразбитой части
     * @param message
     * @returns {number}
     */
    getSplitProbabilityByCurrentPart(message) {
        return 2 / (1 + Math.exp(-0.044 * message.length)) + 1;
    }

});

/**
 * Представляет отложенный в очередь ответ бота
 * @class
 */
AggroBot.QueuedResponse = class {

    /**
     * @constructor
     * @param {string} message
     */
    constructor(message) {

        /**
         * Сообщение
         * @type {string}
         */
        this.message = message;

        /**
         * Время, необходимое для чтения запроса
         * @type {number}
         */
        this.readDelay = 0;

        /**
         * Время, необходимое для печати ответа
         * @type {number}
         */
        this.typeDelay = AggroBot.getTimeToType(message);

        /**
         * Флаг: будет ли чтение или набор прервано новым сообщением от собеседника
         * @type {boolean}
         */
        this.interruptOnMessage = true;

        /**
         * Флаг: будет ли чтение или набор прервано статусом печати от собеседника
         * @type {boolean}
         */
        this.interruptOnTyping = true;

        /**
         * Флаг: будет ли отправка данного ответа отменена при получении сообщения от собеседника
         * @type {boolean}
         */
        this.discardOnMessage = false;

        /**
         * Флаг: будет ли данный ответ мешать добавлению в очередь нового первичного ответа
         * @type {boolean}
         */
        this.blockQueue = true;

    }

};

/**
 * База сообщений бота
 * @class
 */
AggroBot.Database = class {

    /**
     * Генерирует новое состояние базы сообщений
     */
    reset() {

        // noinspection JSCheckFunctionSignatures
        Object.keys(this).forEach(key => this[key].reset());

    }

    /**
     * Возвращает случайный ответ по ключу
     * @param key
     * @returns {AggroBot.Response}
     */
    getRandom(key) {

        return this[key].getRandom();

    }

};

Object.assign(AggroBot.Database, {

    /**
     * Создает базу сообщений на основе сырого объекта с сообщениями
     * @param {Object} raw
     * @returns {AggroBot.Database}
     */
    fromRaw(raw) {

        const database = new AggroBot.Database();
        Object.keys(raw).forEach(key => {
            const set = new AggroBot.ResponseSet();
            raw[key].forEach(string => set.add(new AggroBot.Response(new String(string))));
            database[key] = set;
        });

        return database;

    },

    /**
     * Создает базу сообщений на основе другой базы сообщений
     * @param {AggroBot.Database} anotherDatabase
     * @returns {AggroBot.Database}
     */
    fromAnother(anotherDatabase) {

        const database = new AggroBot.Database();
        // noinspection JSCheckFunctionSignatures
        Object.keys(anotherDatabase).forEach(key => {
            const set = new AggroBot.ResponseSet();
            anotherDatabase[key].forEach(response => set.add(new AggroBot.Response(response.string)));
            database[key] = set;
        });

        return database;

    }

});

/**
 * Множество ответов бота
 * @class
 */
AggroBot.ResponseSet = class {

    /**
     * @constructor
     */
    constructor() {

        this._array = [];
        this._totalAvailable = 0;

    }

    /**
     * Добавляет ответ
     * @param response
     */
    add(response) {

        this._array.push(response);
        this._totalAvailable++;

    }

    /**
     * Итерирует множество
     * @param func
     */
    forEach(func) {

        this._array.forEach(func);

    }

    /**
     * Генерирует новое состояние ответов
     */
    reset() {

        this._totalAvailable = this._array.length;
        this.forEach(response => response.used = false);

    }

    /**
     * Возвращает случайный ответ из множества
     * @returns {AggroBot.Response}
     */
    getRandom() {

        const index = Math.floor(Math.random() * this._totalAvailable);
        let counter = 0;
        for (let response of this._array) if (!response.used) {
            if (index == counter) {
                response.used = true;
                return response;
            }
            counter++;
        }

        this.reset();
        return this.getRandom();

    }

};

/**
 * Ответ бота
 * @class
 */
AggroBot.Response = class {

    /**
     * @constructor
     * @param {String} string Текст ответа
     */
    constructor(string) {

        /**
         * Текст ответа
         * @type {String}
         */
        this.string = string;

        /**
         * Использован ли ответ
         * @type {boolean}
         */
        this.used = false;

    }

};

/**
 * Информация о пользователе, с которым общается бот
 * @class
 */
AggroBot.UserProfile = class {

    constructor() {

        /**
         * Гендер
         * @type {AggroBot.UserProfile.Gender}
         */
        this.gender = AggroBot.UserProfile.Gender.MALE;

    }

};

/**
 * Гендеры
 * @enum
 * @readonly
 */
AggroBot.UserProfile.Gender = Object.freeze({
    MALE: 0,
    FEMALE: 1
});

/**
 * Стиль письма
 * @class
 */
AggroBot.Style = class {

    /**
     * Генерирует новый стиль
     * @constructor
     */
    constructor() {

        /**
         * Вероятность совершения опечатки в букве,
         * а также вероятности совершения разных видов опечаток,
         * соответственно перестановки букв, ввод не той буквы и добавление/удаление буквы.
         * @type {number}
         */
        this.typoProbability = Math.pow(2, 17 * Math.random() - 20.1) + 0.001;
        //this.typoProbability = Math.max(0.00025, 13 * Math.pow(Math.random() - 0.485, 7) + 0.001);
        console.log(`Typo probability: ${this.typoProbability.toFixed(6)}`);
        this.swapTypoProbability = Math.random() * 2 / 3;
        this.mishitTypoProbability = Math.random() * (1 - this.swapTypoProbability);
        this.alterTypoProbability = 1 - this.swapTypoProbability - this.mishitTypoProbability;

        /**
         * Вероятность исправления опечатки в последующем сообщении
         * @type {number}
         */
        this.typoCorrectionProbabilityMultiplier = Math.pow(Math.random(), 1 / 4);

        /**
         * Будут ли фразы начинаться с заглавной буквы
         * @type {boolean}
         */
        this.capitalize = Math.random() < AggroBot.Style._PROBABILITY_CAPITALIZE;

        /**
         * Вероятности допуска ошибок разных типов
         * @type {Object}
         */
        this.misspellProbability = {

            // Ошибка типа 0: замена а <-> о, и <-> е
            // От 0 до 0.4
            0: Math.pow(2, 9 * Math.random() - 11.4),

            // Ошибка типа 1: -тся/-ться
            1: AggroBot.Style._getTwoOptionProbability(0.15, 0.5),

            // Ошибка типа 2: -ишь, -ешь
            2: AggroBot.Style._getTwoOptionProbability(0.75, 0.375),

            // Ошибка типа 3: мягкий знак после шипящих
            3: AggroBot.Style._getTwoOptionProbability(0.07, 0.6),

            // Ошибка типа 4: жи, ши, ча, ща, чу, щу
            4: AggroBot.Style._getTwoOptionProbability(0.07143, 0.7),

            // Ошибка типа 5: -чк-, -чн-
            5: AggroBot.Style._getTwoOptionProbability(0.2, 0.55),

            // Ошибка типа 6: не- слитно/раздельно
            6: AggroBot.Style._getTwoOptionProbability(0.1, 0.5),

            // Ошибка типа 7: нн <-> н
            7: AggroBot.Style._getTwoOptionProbability(0.1, 0.5),

            // Ошибка типа 8: ого -> ова
            8: AggroBot.Style._getTwoOptionProbability(0.06, 0.8),

            // Ошибка типа 9: шо <-> ше, чо <-> чё, що <-> ще
            9: AggroBot.Style._getTwoOptionProbability(0.1, 0.5),

            // Стиль типа 10: меня -> мя, тебя -> тя
            10: AggroBot.Style._getTwoOptionProbability(0.05, 0.5),

            // Стиль типа 11: вообще -> ваще
            11: AggroBot.Style._getTwoOptionProbability(0.05, 0.5),

            // Двойные согласные
            12: AggroBot.Style._getTwoOptionProbability(0.175, 0.5),

            // тся/ться -> ца
            13: AggroBot.Style._getTwoOptionProbability(0.025, 0.85),

        };

        /**
         * Вероятность того, что восклицательный или вопросительный знак в конце фразы будет в очередной раз повторён
         * @type {number}
         */
        this.questionMarkDuplicationProbability = Math.pow(Math.max((Math.random() - 0.4) / 0.6, 0), 4.5);

        /**
         * Вероятность переноса восклицательного или вопросительного знака в следующее сообщение
         * @type {number}
         */
        this.questionMarkLineBreakProbability = Math.max(2.5 * (Math.random() - 0.6), 0);

        /**
         * Вероятность вставки в конец фразы слова из набора addition
         * @type {number}
         */
        this.additionProbability = Math.pow(Math.max((Math.random() - 0.45) / 0.6, 0), 3.7);

        /**
         * Вероятность написания этого слова в отдельном сообщении
         * @type {number}
         */
        this.additionLineBreakProbability = Math.max(2.5 * (Math.random() - 0.6), 0);

    }

    /**
     * Вставляет во фразу опечатки на основе стиля и также возвращает откорректированные слова
     * @param {string} string
     * @returns {{result: string, corrections: Array<string>}}
     */
    insertTypos(string) {

        const match = string.match(/^[^а-яё]+/i);
        let result = match ? match[0] : "";
        const corrections = [];

        const regExp = /([а-яё]+)([^а-яё]+|$)/ig;
        let lastCorrected = false;
        let matches;
        while (matches = regExp.exec(string)) {
            const part = matches[0];
            if (part.length <= 3) {
                result += part;
                lastCorrected = false;
                continue;
            }
            let newPart = "";
            let typos = 0;
            for (let i = 0; i < part.length; i++) {
                if (Math.random() < this.typoProbability) {
                    console.log(`making a typo in "${part}" @ ${i}`);
                    typos++;
                    let random = Math.random();
                    if (random < this.swapTypoProbability && i != part.length - 1) newPart += part[i + 1] + part[i++];
                    else if ((random -= this.swapTypoProbability) < this.mishitTypoProbability) {
                        const options = AggroBot.Style._KEYBOARD_TYPOS[part[i]];
                        newPart += options ? options[Math.floor(Math.random() * options.length)] : part[i];
                    }
                    else if ((random -= this.mishitTypoProbability) < this.alterTypoProbability) {
                        if (Math.random() < 0.5) {
                            const options = AggroBot.Style._KEYBOARD_TYPOS[part[i]];
                            newPart += part[i] + (options ? options[Math.floor(Math.random() * options.length)] : "");
                            i++;
                        }
                    }
                    else typos--;
                }
                else newPart += part[i];
            }
            result += newPart;
            if (newPart == part) typos = 0;
            if (typos) {
                if (lastCorrected) corrections[corrections.length - 1] += " " + matches[1];
                else if (Math.random() < AggroBot.Style._getTypeCorrectionProbability(typos) *
                    Math.pow(this.typoCorrectionProbabilityMultiplier, corrections.length + 1)) {
                    console.log("Adding correction, prob: " + AggroBot.Style._getTypeCorrectionProbability(typos) *
                        Math.pow(this.typoCorrectionProbabilityMultiplier, corrections.length + 1));
                    corrections.push(matches[1]);
                    lastCorrected = true;
                }
                else lastCorrected = false;
            }
            else lastCorrected = false;
        }

        return {result, corrections};

    }

    /**
     * Вставляет во фразу ошибки на основе стиля
     * @param {string} string
     * @returns {string}
     */
    misspell(string) {

        // Тип 0
        {
            const wordRegExp = /([а-яё]+)([^а-яё]+|$)/ig;
            const letterRegExp = /[аеёиоуыэюя](?=[а-яё])/g;
            let result = "";
            let matches;
            while (matches = wordRegExp.exec(string)) {
                const part = matches[0];
                const letters = part.match(letterRegExp);
                if (!letters || letters.length < 2) { // Пропускаем короткие слова
                    result += part;
                    continue;
                }
                result += part.replace(letterRegExp, (letter, offset) => {
                    if ("аоеи".indexOf(letter) == -1 || Math.random() > this.misspellProbability[0]) return letter;
                    console.log(`misspelling "${part}" with type 0 @ ${offset}`);
                    switch (letter) {
                        case "а": return "о";
                        case "о": return "а";
                        case "е": return "и";
                        case "и": return "е";
                    }
                });
            }
            string = result;
        }

        // Тип 1–11
        {
            [
                /т(ь?)ся(?![а-яё])/g,
                /([еёи])шь(?![а-яё])/g,
                /([аоуыэюя][жчшщ])(ь?)(?![а-яё])/g,
                /[жш]и|[чщ][ау]/g,
                /ч([кн])/g,
                /([^а-яё]|^)н([еи])( ?)(?=[а-яё]{3,})/g,
                /([а-яё]+[аеёиоуыюя])(н+)(?=(?:[ыиао]й|[аоя]я|[аоеи](?:е|го|му)|ик|ица)(?:[^а-яё]|$))/g,
                /([а-яё]{3,}[аоеи])го(?![а-яё])/g,
                /([жчшщ])([еёо])(?=[а-чщ-яё])/g,
                /([^а-яё]|^)([мт])(ен|еб)я(?![а-яё])/g,
                /в([ао]{1,2})бще/g,
                /([бвгджзклмпрстфхцчшщ])\1/g,
                /ть?ся(?![а-яё])/g
            ].forEach((regExp, index) => {
                const type = index + 1;
                string = string.replace(regExp, (...matches) => {
                    if (Math.random() > this.misspellProbability[type]) return matches[0];
                    console.log(`misspelling "${string}" with type ${type} @ ${matches[matches.length - 2]}`);
                    switch (type) {
                        case 1:
                            return "т" + (matches[1] ? "" : "ь") + "ся";
                        case 2:
                            return matches[1] + "ш";
                        case 3:
                            return matches[1];
                        case 4:
                            const letter = matches[0].charAt(1);
                            return matches[0].charAt(0) + (letter == "и" ? "ы" : letter == "а" ? "я" : "ю");
                        case 5:
                            return "чь" + matches[1];
                        case 6:
                            return matches[1] + "н" + matches[2] + (matches[3] ? "" : " ");
                        case 7:
                            return matches[1] + (matches[2].length == 1 ? "нн" : "н");
                        case 8:
                            return matches[1] + "ва";
                        case 9:
                            return matches[1] + (matches[2] == "е" || matches[2] == "ё" ? "о" : "е");
                        case 10:
                            return matches[1] + matches[2] + "я";
                        case 11:
                            return "ваще";
                        case 12:
                            return matches[1];
                        case 13:
                            return "ца";
                    }
                });
            });
        }

        return string;

    }

};

// noinspection NonAsciiCharacters
Object.assign(AggroBot.Style, {

    /**
     * Возможные подмены букв с целью симуляции опечатки
     * @private
     */
    _KEYBOARD_TYPOS: {
        "й": "цф1", "ц": "фыу", "у": "цывк", "к": "увае", "е": "капн", "н": "епрг", "г": "нрош", "ш": "голщ",
        "з": "щджх", "х": "зжэъ", "ъ": "хэ", "ф": "йцыя", "ы": "цфячв", "в": "уычса", "а": "квсмпе",
        "п": "еамир", "р": "нпито", "о": "гртьл", "л": "шоьбд", "д": "щлбюж", "ж": "здюэ", "э": "хжъ",
        "я": "фыч", "ч": "яывс", "с": "чвам ", "м": "пас и", "и": "пм тр", "т": "ори ь", "ь": "от бл", "б": "ьлдю",
        "ю": "бдж"
    },

    /**
     * Возвращает вероятность коррекции опечаток в слове на основе количества опечаток
     * @param {number} amountOfTypos
     * @returns {number}
     * @private
     */
    _getTypeCorrectionProbability(amountOfTypos) {
        switch (amountOfTypos) {
            case 0: return 0;
            case 1: return 0.3;
            case 2: return 0.775;
            case 3: return 0.925;
            default: return 1;
        }
    },

    /**
     * Вероятность установки заглавной буквы во всех вразах
     * @private
     */
    _PROBABILITY_CAPITALIZE: 2 / 3,

    /**
     * Получает очень малую или очень большую вероятность, являющуюся результатом
     * кусочно-линейной функции с наклоном slope и точкой разрыва balance
     * @param {number} slope
     * @param {number} balance
     * @returns {number}
     * @private
     */
    _getTwoOptionProbability(slope, balance) {
        const random = Math.random();
        return slope * random + (random <= balance ? 0 : 1 - slope);
    }

});

VPP.Chat.prototype.aggrobot = (command, ...args) => {

    switch (command) {

        case "download":

            const $a = $("<a>").attr({
                href: VPPScript.meta["script-url"],
                download: VPPScript.meta["script-filename"]
            }).appendTo("body");
            $a[0].click();
            $a.remove();

            break;

    }

};

VPPScript.stop = () => {

    VPP.chats.forEach(chat => {
        if (chat.aggroBot) {
            chat.aggroBot.suspend();
            delete chat.aggroBot;
        }
        chat.removeEventListener("aggrobot");
    });
    delete VPP.Chat.prototype.aggrobot;

};
