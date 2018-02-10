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

        if (compareVersions(response["script_version"], VPPScript.meta["version"]) < 0) {
            return log(`Вы используете устаревший скрипт.<br>
Текущая версия: ${VPPScript.meta["version"]}<br>
Последняя версия: ${response["script_version"]}<br>
Введите "/aggrobot download", чтобы скачать последнюю версию.`);
        }
        log("Вы используете последнюю версию скрипта.");

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
        aggroBot.onConversationFinish = () => {
            aggroBot.suspend();
            chat.isChatStarted() && chat.close();
        };
        aggroBot.onReport = message => chat.log(message);

        chat.removeEventListener("aggrobot");
        chat.addEventListener(VPP.Chat.Event.CONNECTED, "aggrobot", () => {

            // Генерируем новое состояние бота и готовим приветственное сообщение
            aggroBot.reset();
            aggroBot.prepareResponse();

        });

        chat.addEventListener(VPP.Chat.Event.MESSAGE_RECEIVED, "aggrobot", (type, content) => {

            let request;
            switch (type) {
                case VPP.Chat.MessageType.TEXT:
                    request = new AggroBot.Request(AggroBot.Request.Type.TEXT);
                    request.text = content;
                    break;
                case VPP.Chat.MessageType.IMAGE:
                    request = new AggroBot.Request(AggroBot.Request.Type.PHOTO);
                    request.photoURL = content;
                    break;
                case VPP.Chat.MessageType.STICKER:
                    request = new AggroBot.Request(AggroBot.Request.Type.STICKER);
                    const groupId = +content.match(/\/stickers\/(\d+)\//i)[1];
                    switch (groupId) {
                        case 4: request.stickerGroupName = "pony"; break;
                        case 6: request.stickerGroupName = "cat"; break;
                        case 8: request.stickerGroupName = "nichosi"; break;
                        case 9: request.stickerGroupName = "seagull"; break;
                    }
                    break;
            }
            aggroBot.receiveMessage(request);
            aggroBot.prepareResponse(request);

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
         * Намеревается ли бот покинуть чат после опустошения очереди
         * @type {boolean}
         * @private
         */
        this._intendsToLeave = false;

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

        /**
         * Переменные, подставляемые во фразы
         * @type {object}
         * @private
         */
        this._variables = {};

        /**
         * Детектор флуда/спама
         * @type {AggroBot.SpamDetector}
         * @private
         */
        this._spamDetector = new AggroBot.SpamDetector();

        /**
         * Последний запрос, который посчитался флудом/спамом
         * @type {AggroBot.Request}
         * @private
         */
        this._spamRequest = null;

        /**
         * Флаг установлен, если бот игнорирует запросы о подготовке ответа
         * @type {boolean}
         * @private
         */
        this._ignoringPrepareRequests = false;

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
     * @param {AggroBot.Request} request Сообщение от собеседника
     */
    receiveMessage(request) {

        // Пытаемся определить пол
        if (request.type === AggroBot.Request.Type.TEXT) this._determineGender(request.text);

        // Полученное сообщение считается активностью, поэтому сбрасываем счётчик
        this._inactivityCounter = 0;
        this._intendsToLeave = false;

        this._directResponse = true;

        // Смотрим, есть ли в очереди ответы, которые должны быть удалены из очереди во время получения сообщения
        let queueUpdated = false;
        if (this._responseQueue[0] && this._responseQueue[0].discardOnMessage) {
            this._removeNextQueuedResponse();
            queueUpdated = true;
        }
        this._responseQueue = this._responseQueue.filter(queued => !queued.discardOnMessage);
        if (queueUpdated) this._setQueueUpdated();

        // Если бот получил сообщение, пока писал своё, он отвлекается на его прочтение
        const nextQueued = this._responseQueue[0];
        if (nextQueued) {
            if (nextQueued.interruptOnMessage) this._interrupt(AggroBot.getTimeToRead(request));
        }
        
        // Проверяем на спам/флуд
        const alreadyResponding = this._responseQueue.some(queued => queued.isSpamResponse);
        const {result, variables} = this._spamDetector.analyzeNext(request, alreadyResponding);
        if (result) {
            this._spamRequest = request;
            if (!alreadyResponding) {
                Object.assign(this._variables, variables);
                this._processAndAddToQueue(this._getMessage(result), {
                    readDelay: AggroBot.getTimeToRead(request),
                    isSpamResponse: true
                });
            }
        }
        else {
            this._spamRequest = null;
            this._ignoringPrepareRequests = this._spamDetector.state === AggroBot.SpamDetector.State.IGNORING;
            if (!this._ignoringPrepareRequests && this._responseQueue[0] && this._responseQueue[0].isSpamResponse) {
                this._removeNextQueuedResponse();
                this._setQueueUpdated();
            }
        }
        
        if(!this._responseQueue[0]) this._resetInactiveTimeout();

    }

    /**
     * Готовит и откладывает ответ собеседнику
     * @param {AggroBot.Request} request Сообщение от собеседника
     */
    prepareResponse(request = null) {

        if (this._ignoringPrepareRequests || request != null && this._spamRequest == request) return;

        // Отправляем приветствие
        if (!this._greeted) {
            this._greeted = true;
            this._processAndAddToQueue(this._getMessage("greetings"), {
                discardOnMessage: true
            });
            return;
        }

        // Проверяем, занят ли бот
        const ready = !this._responseQueue[0] || this._responseQueue.every(queued => !queued.blockQueue);
        let added = false;

        // Пытаемся найти ответ по регулярному выражению или на особые типы контента
        if (request != null) switch (request.type) {
            case AggroBot.Request.Type.TEXT:
                const {message, pattern} = this._getAnswer(request.text);
                if (message != null) this._processAndAddToQueue(message, {
                    readDelay: AggroBot.getTimeToRead(request),
                    pattern: pattern
                }) && (added = true);
                break;
            case AggroBot.Request.Type.PHOTO:
                if (!this._responseQueue.some(queued => queued.pattern == "photo")) this._processAndAddToQueue(this._getMessage("photo"), {
                    readDelay: AggroBot.getTimeToRead(request),
                    pattern: "photo"
                }) && (added = true);
                break;
            case AggroBot.Request.Type.STICKER:
                const databaseKey = `sticker_${request.stickerGroupName}`;
                if (this._database.has(databaseKey) && !this._responseQueue.some(queued => queued.pattern == "sticker")) {
                    this._processAndAddToQueue(this._getMessage(databaseKey), {
                        readDelay: AggroBot.getTimeToRead(request),
                        pattern: "sticker"
                    });
                    added = true;
                }
                break;
        }

        // Добавляем в очередь новый первичный ответ, если бот не занят
        if (!added && ready) {
            this._processAndAddToQueue(this._getMessage("primary"), {
                readDelay: AggroBot.getTimeToRead(request)
            });
            added = true;
        }

        // Добавляем вторичные ответы
        if (added) while (Math.random() < AggroBot.PROBABILITY_SECONDARY) {
            this._processAndAddToQueue(this._getMessage("secondary"), {
                readDelay: AggroBot.TIME_ADDITIONAL_READ_DELAY,
                interruptOnTyping: false,
                discardOnMessage: true
            });
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
        if (this._readTimeout || this._typeTimeout || this._interruptedTimeout) return;

        // Если очередь не пустая, запускаем таймер чтения последнего сообщения.
        // Иначе запускаем таймер неактивности собеседника.
        const queued = this._responseQueue[0];
        if (queued) this._readTimeout = setTimeout(this._setReadingFinished.bind(this), queued.readDelay);
        else if (this._intendsToLeave) setTimeout(this.onConversationFinish.bind(this), 100);
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
     * неактивности по его истечении.
     * При каждом прибавлении бот выполняет действия, направленные на привлечение внимания собеседника.
     * Если собеседник неактивен несколько тиков подряд, соединение разрывается.
     * @private
     */
    _resetInactiveTimeout() {

        clearTimeout(this._activityCheckTimeout);
        if (!this._intendsToLeave) this._activityCheckTimeout = setTimeout(() => {
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
                case 4:
                    this._intendsToLeave = true;
                    this._processAndAddToQueue(this._getMessage("before_leaving"), {
                        discardOnMessage: true
                    });
                    break;
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
     * Отменяет подготовку к отправке следующего ответа в очереди
     * @private
     */
    _removeNextQueuedResponse() {

        this._responseQueue.shift();
        clearTimeout(this._readTimeout);
        clearTimeout(this._typeTimeout);
        clearTimeout(this._interruptedTimeout);
        this._readTimeout = null;
        this._typeTimeout = null;
        this._interruptedTimeout = null;
        this._resetInactiveTimeout();

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
     * Возвращает случайное необработанное сообщение из базы сообщений по ключу
     * @param {string} databaseKey
     * @returns {string}
     * @private
     */
    _getRawMessage(databaseKey) {

        return this._database.getRandom(databaseKey).string;

    }

    /**
     * Обрабатывает функции и флаги внутри строки
     * @param {string} message
     * @param {Array<string>} matches Массив совпадений для %m
     * @returns {string | null}
     * @private
     */
    _processMessage(message, matches = []) {

        if (message == null) return null;

        let invalid = false;
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
                    if (!this._directResponse) invalid = true;
                    break;
                case "nd":
                case "nondirect":
                    if (this._directResponse) invalid = true;
                    break;
                case "firstname":
                    return AggroBot.firstName.toLowerCase();
                case "lastname":
                    return AggroBot.lastName.toLowerCase();
                case "shortname":
                    return AggroBot.shortName.toLowerCase();
                case "m":
                case "match":
                    return (matches[+(args[0] || 0)] || "").toLowerCase();
                case "ifm":
                case "ifmatch":
                    invalid = !matches[+args[0]];
                    break;
                case "ifnm":
                case "ifnomatch":
                    invalid = !!matches[+args[0]];
                    break;
                case "timeschedule": {
                    const to12HourFormat = hours => hours % 12 || 12;
                    const toFullHourFormat = hours => {
                        const hours12 = to12HourFormat(hours);
                        return hours12 == 1 ? "час" : `${hours12} час${hours12 < 5 ? "а" : "ов"}`;
                    };
                    const now = new Date();
                    const minutes = now.getMinutes();
                    const hours = now.getHours();
                    if (minutes <= 15) return toFullHourFormat(hours);
                    if (minutes < 45) return `${minutes <= 25 ? "почти" : ""} пол ${to12HourFormat(hours + 1)}`;
                    return "почти " + toFullHourFormat(hours + 1);
                }
                case "timeofday": {
                    const now = new Date();
                    const hours = now.getHours() + now.getMinutes() / 100;
                    if (hours < 5.30 || hours > 23.30) return "посреди ночи";
                    if (hours < 12) return "с утра";
                    if (hours < 18) return "посреди дня";
                    return "весь вечер";
                }
                case "timedayofweek":
                    return ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][new Date().getDay()];
                default:
                    if (typeof this._variables[name] === "string") return this._variables[name];
                    else if (typeof this._variables[name] === "function") return this._variables[name].apply(this, args);
            }

            return "";

        }).replace(/[$@]\w+/g, "");
        return !invalid ? message : null;

    }

    /**
     * Возвращает случайное сообщение из базы сообщений по ключу
     * @param {string} databaseKey
     * @returns {string}
     * @private
     */
    _getMessage(databaseKey) {

        let message = this._processMessage(this._getRawMessage(databaseKey));
        return message != null ? message : this._getMessage(databaseKey);

    }

    /**
     * По возможности возвращает ответ на сообщение по регулярному выражению
     * @param {string} request
     * @returns {{message: string | null, pattern: RegExp | null}}
     * @private
     */
    _getAnswer(request) {

        const {response, matches, pattern} = this._database.match(request);
        let message = null;

        // Отменяем ответ по регулярному выражению, если ответ на это же самое выражение уже есть в очереди
        if (response != null && !this._responseQueue.some(queued => queued.pattern === pattern)) {
            message = this._processMessage(response.string, matches);
            if (message == null) return this._getAnswer(request);
        }

        return {message, pattern};

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
        
        // Вставляем слова из специальных наборов
        splitResult.forEach(queued => {
            const wordRegExp = AggroBot.Style.wordRegExp;
            wordRegExp.lastIndex = 0;
            let changed = false;
            let lastWord = "";
            queued.message = queued.message.replace(wordRegExp, (match, p1) => {
                let replacement = match;
                if (Math.random() < this._style.insideInsertionProbability) {
                    const word = this._getMessage("insert_inside");
                    if (p1 != word && lastWord != word && AggroBot.Style.PREPOSITIONS_OR_CONJUNCTIONS.indexOf(lastWord) == -1) {
                        replacement = `${word} ${match}`;
                        changed = true;
                    }
                    else console.log(`@@@ Not inserting because ${p1} or ${lastWord} == ${word} or ${lastWord} is a prop or conj`);
                }
                lastWord = p1;
                return replacement;
            });
            if (Math.random() < this._style.afterInsertionProbability) {
                queued.message = queued.message.replace(/[^а-яё\d]*$/, ` ${this._getMessage("insert_after")}$&`);
                changed = true;
            }
            if (changed) queued.calculateTypeDelay();
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
        if (/((^[^а-яё]*я? ?|([^а-я]|^)я ([а-яё]+[ \-])*)([жд](?=$|\s?[.,])|дев(оч|ч[ео]н|уш)ка|женщина|баба|телка|тянк?а?)|(^|[^а-яё])я\s+[а-яё]{3,}(ая|[кл]а))($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|я\s+не\s+(м|парень?|пацан|мальчик|муж(ик|чина)?|чувак)($|[^а-яё])|((я|меня)\s+|^)(Александра|Алина|Алиса|Алла|Аля|Анастасия|Настя|Анна|Аня|Адель|Валерия|Вера|Виктория|Вика|Галя|Дарья|Даша|Диана|Ева|Евгения|Екатерина|Катя|Катюша|Елена|Лена|Ленка|Лера|Елизавета|Лиза|Элиза|Ира|Ирина|Ирочка|Карина|Кира|Кристина|Ксения|Ксюша|Лариса|Лида|Лидия|Лилия|Лиля|Люба|Людмила|Люда|Людочка|Маргарита|Марго|Рита|Марина|Мария|Маша|Милена|Мила|Надежда|Надя|Наталья|Наташа|Ната|Ника|Нина|Оксана|Олеся|Ольга|Оля|Полина|Поля|Светлана|Света|Светка|Софья|Софа|Соня|Татьяна|Таня|Танюша|Ульяна|Уля|Юлия|Юля|Юлька|Яна)([^а-яё?]|$)/i.test(message)) {
            gender = AggroBot.UserProfile.Gender.FEMALE;
        }
        else if (/((^[^а-яё]*я? ?|([^а-я]|^)я ([а-яё]+[ \-])*)(м|парень?|пацан|мальчик|муж(ик|чина)?)|(^|[^а-яё])я\s+[а-яё]{2,}(ый|л))($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|я\s+не\s+([жд]|дев(оч|ч[ео]н|уш)ка|женщина|баба|телка|тянк?а?)($|[^а-яё])|((я|меня)\s+|^)(Александр|Саша|Алексей|Леша|Леха|Андрей|Антон|Тоха|Артем|Артур|Ваня|Василий|Вася|Виктор|Витя|Виталий|Владимир|Вова|Влад|Глеб|Григорий|Георгий|Гриша|Данил|Даниил|Данила|Денис|Дмитрий|Дима|Евгений|Женя|Егор|Иван|Игорь|Илья|Илюха|Кирилл|Костя|Макс|Максим|Матвей|Михаил|Миша|Миха|Никита|Николай|Коля|Колян|Олег|Павел|Паша|Рома|Роман|Семен|Сема|Сергей|Сережа|Стас|Тимур|Юрий|Юра)([^а-яё?]|$)/i.test(message)) {
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
     * Возвращает время, необходимое для чтения запроса, мс
     * @param {AggroBot.Request} request
     * @returns {number}
     */
    getTimeToRead(request) {
        if (request == null) return 0;
        switch (request.type) {
            case AggroBot.Request.Type.TEXT:
                return 850 + 350 * (request.text + " ").match(/\s/g).length;
            case AggroBot.Request.Type.PHOTO:
                return 3500;
            case AggroBot.Request.Type.STICKER:
                return 2200;
        }
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
    },

    /**
     * Внутреннее имя бота
     */
    firstName: "Антон",

    /**
     * ... фамилия бота
     */
    lastName: "Васютин",

    /**
     * ... короткое имя бота
     */
    shortName: "Тоха"

});

/**
 * Представляет запрос боту
 * @class
 */
AggroBot.Request = class {

    /**
     * @constructor
     * @param {number} type Тип контента запроса
     */
    constructor(type) {

        /**
         * Тип контента запроса
         * @type {number}
         */
        this.type = type;

        switch (type) {
            case AggroBot.Request.Type.TEXT:
                this.text = "";
                break;
            case AggroBot.Request.Type.PHOTO:
                this.photoURL = null;
                break;
            case AggroBot.Request.Type.STICKER:
                this.stickerGroupName = null;
                break;
        }

    }

};

/**
 * Тип контента запроса
 * @enum
 * @readonly
 */
AggroBot.Request.Type = Object.freeze({
    TEXT: 0,
    PHOTO: 1,
    STICKER: 2
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

        /**
         * Шаблон, по которому найден ответ
         * @type {*}
         */
        this.pattern = null;
        
        this.isSpamResponse = false;

        this.calculateTypeDelay();

    }

    /**
     * Считает время, необходимое для печати ответа
     */
    calculateTypeDelay() {

        /**
         * Время, необходимое для печати ответа
         * @type {number}
         */
        this.typeDelay = AggroBot.getTimeToType(this.message);

    }

};

/**
 * База сообщений бота
 * @class
 */
AggroBot.Database = class {

    constructor() {

        /**
         * @type {Array<AggroBot.Matcher>}
         */
        this.answers = [];

    }

    /**
     * Генерирует новое состояние базы сообщений
     */
    reset() {

        // noinspection JSCheckFunctionSignatures
        Object.keys(this).forEach(key => key !== "answers" && this[key].reset());

    }

    /**
     * Определяет, есть ли в базе сообщений множество ответов с данным ключом
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {

        return this[key] instanceof AggroBot.ResponseSet;

    }

    /**
     * Возвращает случайный ответ по ключу
     * @param key
     * @returns {AggroBot.Response}
     */
    getRandom(key) {

        return this[key].getRandom();

    }

    /**
     * Возвращает случайный ответ по регулярному выражению с массивом совпадений в запоминающих скобках
     * @param {string} message
     * @returns {{matches: Array<string> | null, response: AggroBot.Response | null, pattern: RegExp | null}} случайный ответ и массив совпадений
     */
    match(message) {

        for (let matcher of this.answers) {
            const {response, matches, pattern} = matcher.match(message);
            if (response) return {response, matches, pattern};
        }

        return {
            response: null,
            matches: null,
            pattern: null
        };

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
            if (key === "answers") return;
            const set = new AggroBot.ResponseSet();
            raw[key].forEach(string => set.add(new AggroBot.Response(new String(string))));
            database[key] = set;
        });

        if (typeof raw.answers === "object") Object.keys(raw.answers).forEach(regExpStr => {
            const set = new AggroBot.ResponseSet();
            raw.answers[regExpStr].forEach(string => {
                const response = new AggroBot.Response(new String(string));
                response.unique = true;
                set.add(response);
            });
            let regExp;
            try {
                regExp = new RegExp(regExpStr, "i");
            }
            catch (error) {
                console.log("Invalid regular expression in answers: ", regExpStr);
                return;
            }
            database.answers.push(new AggroBot.Matcher(regExp, set));
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
            if (key === "answers") return;
            const set = new AggroBot.ResponseSet();
            anotherDatabase[key].forEach(response => set.add(new AggroBot.Response(response.string)));
            database[key] = set;
        });
        anotherDatabase.answers.forEach(matcher => {
            const set = new AggroBot.ResponseSet();
            matcher.responses.forEach(response => {
                const newResponse = new AggroBot.Response(response.string);
                newResponse.unique = true;
                set.add(newResponse);
            });
            database.answers.push(new AggroBot.Matcher(matcher.regExp, set));
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

        this._totalAvailable = 0;
        this.forEach(response => !response.unique && ++this._totalAvailable && (response.used = false));

    }

    /**
     * Возвращает случайный ответ из множества
     * @returns {AggroBot.Response}
     */
    getRandom() {

        if (!this._totalAvailable) {
            this.reset();
            if (!this._totalAvailable) return null;
        }

        const index = Math.floor(Math.random() * this._totalAvailable);
        let counter = 0;
        for (let response of this._array) if (!response.used) {
            if (index == counter) {
                response.used = true;
                this._totalAvailable--;
                return response;
            }
            counter++;
        }

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

        /**
         * Уникальный ли ответ
         * @type {boolean}
         */
        this.unique = false;

    }

};

AggroBot.Matcher = class {

    /**
     * @constructor
     * @param {RegExp} regExp
     * @param {AggroBot.ResponseSet} responses
     */
    constructor(regExp, responses) {

        this.regExp = regExp;
        this.responses = responses;

    }

    /**
     * Выполняет поиск в строке по регулярному выражению
     * @param {string} string
     * @returns {{matches: null | Array<string>, response: AggroBot.Response | null, pattern: RegExp | null}} случайный ответ и массив совпадений
     */
    match(string) {

        const pattern = this.regExp;
        const matches = string.match(pattern);
        let response = null;
        if (matches) response = this.responses.getRandom();
        return {response, matches, pattern};

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
            9: Math.random() * 0.8,

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

        /**
         * Вероятность вставки в любое место фразы слова из набора insert_inside
         * @type {number}
         */
        this.insideInsertionProbability = Math.pow(2, 8 * Math.random() - 9.7);

        /**
         * Вероятность вставки в конец фразы слова из набора insert_after
         * @type {number}
         */
        this.afterInsertionProbability = Math.pow(2, 7 * Math.random() - 8);

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

        const regExp = AggroBot.Style.wordRegExp;
        regExp.lastIndex = 0;
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
            const wordRegExp = AggroBot.Style.wordRegExp;
            wordRegExp.lastIndex = 0;
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

        return string;

    }

};

// noinspection NonAsciiCharacters
Object.assign(AggroBot.Style, {

    /**
     * Регулярное выражение для поиска слов
     */
    wordRegExp: /([а-яё\d]+)([^а-яё\d]+|$)/ig,

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
    },

    /**
     * Предлоги или союзы, после которых не может быть вставлено слово
     */
    PREPOSITIONS_OR_CONJUNCTIONS: [
        "без", "в", "вне", "во", "вроде", "возле", "внутрь", "внутри", "вокруг", "для", "до", "за", "из",
        "к", "кроме", "ко", "между", "мимо", "на", "над", "надо", "о", "об", "обо", "около", "от", "ото",
        "перед", "передо", "по", "под", "подо", "после", "при", "про", "против", "ради", "с", "среди", "сзади",
        "снизу", "у", "а", "даже", "если", "и", "или", "как", "когда", "но", "пока", "пусть", "тоже", "не", "ни"
    ]

});

/**
 * Представляет детектор флуда в последовательности сообщений
 * @class
 */
AggroBot.SpamDetector = class {

    /**
     * @constructor
     */
    constructor() {

        /**
         * Состояние детектора
         * @type {number}
         */
        this.state = AggroBot.SpamDetector.State.ANALYZING;

        /**
         * Буфер входящих сообщений
         * @type {Array<AggroBot.Request>}
         * @private
         */
        this._buffer = [];
        
    }

    /**
     * Анализирует очередное входящее сообщение
     * @param {AggroBot.Request} request
     * @param {boolean} noStateChange
     * @returns {{result: string | null, variables: object}}
     */
    analyzeNext(request, noStateChange = false) {
        
        let result = null;
        let variables = {};

        this._buffer.push(request);
        if (this._buffer.length > AggroBot.SpamDetector.BUFFER_SIZE) this._buffer.shift();

        if (this._buffer.length >= AggroBot.SpamDetector.MESSAGES_TO_CHECK_SIMPLE) (() => {

            // Проверяем на фразу о прекращении флуда
            if (this.state === AggroBot.SpamDetector.State.IGNORING &&
                    request.type === AggroBot.Request.Type.TEXT &&
                    /надоело|заебала?с|больше не буду/i.test(request.text)) return;

            // Если две последние фразы — не флуд, прекращаем игнорировать
            if (this.state === AggroBot.SpamDetector.State.IGNORING &&
                this._buffer[this._buffer.length - 2].type === AggroBot.Request.Type.TEXT &&
                this._buffer[this._buffer.length - 1].type === AggroBot.Request.Type.TEXT &&
                this._buffer.slice(-2).every(request => AggroBot.SpamDetector.COMMON_MESSAGE_REG_EXP.test(request.text))) return;

            let slice = this._buffer.slice(-AggroBot.SpamDetector.MESSAGES_TO_CHECK_SIMPLE);
            if (slice.every(request => request.type === AggroBot.Request.Type.TEXT)) {

                slice = slice.map(request => request.text);
                const joined = slice.join("");

                // Проверяем на одинаковые символы
                let first = slice[0];
                if (/^(.)\1*$/.test(first) && joined.split("").every(ch => ch == first.charAt(0))) {
                    first = first.charAt(0);
                    const characterName = AggroBot.SpamDetector.CHARACTER_NAMES[first];
                    if (characterName) {
                        result = "spam_character";
                        variables["character"] = first;
                        variables["charactername"] = variation => characterName[variation] || characterName["singular"];
                        return;
                    }
                }

                // Проверяем на разные символы
                if (/^[^а-яё0-9a-z]+$/.test(joined)) return result = "spam_single_symbol";

                // Проверяем на цифры
                if (/^[0-9]+$/.test(joined)) {
                    result = "spam_single_letter_or_digit";
                    variables["letterordigit"] = (letter, digit) => digit;
                    variables["gletterordigit"] = function(letterMale, digitMale, letterFemale, digitFemale) {
                        return this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ? digitMale : digitFemale;
                    };
                    return;
                }

                // Проверяем на одиночные буквы
                if (slice.every(str => /^[а-яёa-z]$/.test(str))) {
                    result = "spam_single_letter_or_digit";
                    variables["letterordigit"] = letter => letter;
                    variables["gletterordigit"] = function(letterMale, letterFemale) {
                        return this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ? letterMale : letterFemale;
                    };
                    return;
                }

                // Проверяем на повторы
                const clean = str => str.replace(/[^а-яё0-9 ]/g, "");
                first = clean(first);
                if (slice.every(str => clean(str) == first)) return result = "spam_repetition";

            }

            // Проверяем на бред
            if (this._buffer.length >= AggroBot.SpamDetector.MESSAGES_TO_CHECK_ADVANCED) {
                const slice = this._buffer.slice(-AggroBot.SpamDetector.MESSAGES_TO_CHECK_ADVANCED);
                if (slice.every(request => request.type === AggroBot.Request.Type.TEXT) &&
                        !slice.some(request => AggroBot.SpamDetector.COMMON_MESSAGE_REG_EXP.test(request.text))) {
                    console.log("SPAM_REGULAR: ", JSON.stringify(slice));
                    return result = "spam_regular";
                }
            }

        })();

        // Проверяем на фото и стикеры
        if (!result && this._buffer.length >= AggroBot.SpamDetector.PHOTOS_CONSIDERED_SPAM &&
                this._buffer.slice(-AggroBot.SpamDetector.PHOTOS_CONSIDERED_SPAM).every(request =>
                    request.type === AggroBot.Request.Type.PHOTO)) result = "spam_photo";
        if (!result && this._buffer.length >= AggroBot.SpamDetector.STICKERS_CONSIDERED_SPAM &&
                this._buffer.slice(-AggroBot.SpamDetector.STICKERS_CONSIDERED_SPAM).every(request =>
                    request.type === AggroBot.Request.Type.STICKER)) result = "spam_sticker";

        if (!noStateChange) {
            if (result) switch (this.state) {
                case AggroBot.SpamDetector.State.ANALYZING:
                    this.state = AggroBot.SpamDetector.State.DETECTED_FIRST;
                    break;
                case AggroBot.SpamDetector.State.DETECTED_FIRST:
                    result = "spam_aggressive";
                    variables = {};
                    this.state = AggroBot.SpamDetector.State.DETECTED_SECOND;
                    break;
                case AggroBot.SpamDetector.State.DETECTED_SECOND:
                    result = "spam_ignoring";
                    variables = {};
                    this.state = AggroBot.SpamDetector.State.IGNORING;
                    break;
                case AggroBot.SpamDetector.State.IGNORING:
                    result = null;
                    break;
            }
            else this.state = AggroBot.SpamDetector.State.ANALYZING;
        }

        return {result, variables};
        
    }
    
};

Object.assign(AggroBot.SpamDetector, {
    
    State: {
        ANALYZING: 0,
        DETECTED_FIRST: 1,
        DETECTED_SECOND: 2,
        IGNORING: 3
    },
    
    BUFFER_SIZE: 4,
    MESSAGES_TO_CHECK_SIMPLE: 3,
    MESSAGES_TO_CHECK_ADVANCED: 4,
    STICKERS_CONSIDERED_SPAM: 2,
    PHOTOS_CONSIDERED_SPAM: 3,

    CHARACTER_NAMES: {
        "!": {singular: "воскл знак", plural: "воскл знаки", accusative: "воскл знак"},
        "\"": {singular: "кавычка", plural: "кавычки", accusative: "кавычку"},
        "#": {singular: "решетка", plural: "решетки", accusative: "решетку"},
        "$": {singular: "доллар", plural: "доллары", accusative: "доллар"},
        "%": {singular: "процент", plural: "проценты", accusative: "процент"},
        "&": {singular: "энд", plural: "энды", accusative: "энд"},
        "'": {singular: "кавычка", plural: "кавычки", accusative: "кавычку"},
        "(": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        ")": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "*": {singular: "звездочка", plural: "звездочки", accusative: "звездочку"},
        "+": {singular: "плюс", plural: "плюсы", accusative: "плюс"},
        ",": {singular: "запятая", plural: "запятые", accusative: "запятую"},
        "-": {singular: "тире", plural: "тире", accusative: "тире"},
        ".": {singular: "точка", plural: "точки", accusative: "точку"},
        "/": {singular: "палочка", plural: "палочки", accusative: "палочку"},
        ":": {singular: "двоеточие", plural: "двоеточия", accusative: "двоеточие"},
        ";": {singular: "точка с запятой", plural: "точки с запятыми", accusative: "точку с запятой"},
        "<": {singular: "меньше", plural: "меньше", accusative: "меньше"},
        ">": {singular: "больше", plural: "больше", accusative: "больше"},
        "=": {singular: "равно", plural: "равно", accusative: "равно"},
        "?": {singular: "вопрос", plural: "вопросы", accusative: "вопрос"},
        "@": {singular: "собака", plural: "собаки", accusative: "собаку"},
        "[": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "]": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "\\": {singular: "палочка", plural: "палочки", accusative: "палочку"},
        "^": {singular: "крышечка", plural: "крышечки", accusative: "крышечку"},
        "_": {singular: "тире", plural: "тире", accusative: "тире"},
        "`": {singular: "кавычка", plural: "кавычки", accusative: "кавычку"},
        "{": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "|": {singular: "палочка", plural: "палочки", accusative: "палочку"},
        "}": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "~": {singular: "волна", plural: "волны", accusative: "волну"},
    },

    COMMON_WORDS: [
        "и", "в", "не", "на", "я", "был", "была", "он", "с", "что", "а", "по", "это", "она", "этот", "к", "но", "они",
        "мы", "как", "из", "у", "то", "за", "свой", "что", "весь", "год", "от", "так", "о", "для", "ты", "же", "все",
        "тот", "мочь", "вы", "человек", "такой", "его", "только", "или", "еще", "бы", "себя", "один", "как", "уже",
        "до", "время", "если", "сам", "когда", "вот", "наш", "мой", "при", "дело", "жизнь", "кто", "очень",
        "два", "день", "ее", "рука", "даже", "во", "со", "раз", "где", "там", "под", "можно", "ну", "после", "их",
        "без", "потом", "надо", "ли", "идти", "должен", "место", "ничто", "то", "сейчас",
        "тут", "лицо", "друг", "нет", "теперь", "ни", "да", "меня", "мне", "мной", "нас", "ее", "её", "м", "иди"
    ],

    COMMON_LETTER_COMBINATIONS: [
        "а ", "я ", "ой", "ска", "чка", "ай", "ть", "сто", "чик", "щик", "зна", "ста", "жи", "ный", "рый", "вый", "гов",
        "дый", "нна", "енн", "ян", "бы", "что", "име", "ша", "шка", "нка", "ние", "ия", "ого", "ому", "ами", "ыми",
        "ему", "ах", "ях", "вш", "ющ", "ущ", "ащ", "ящ", "ых", "ым", "при", "за", "из", "про", "пре", "анн", "ую",
        "инт", "тел", "ов", "ера", "ко", "во", "аз", "ад", "ал", "чо", "ле", "ет", "ут", "ют", "ат", "еб", "аб", "еш",
        "иц", "ец", "ца", "ци", "це", "оц", "цо", "ина", "шк", "тво", "сво", "мои", "мое", "теб", "тоб", "нам", "наш",
        "ваш", "ней", "нее", "ним", "иш", "ищ", "чь", "ий", "эй", "чит", "очи"
    ]
    
});

AggroBot.SpamDetector.COMMON_MESSAGE_REG_EXP = new RegExp(`([^а-яё]|^)(${AggroBot.SpamDetector.COMMON_WORDS.join("|")})([^а-яё]|$)|(${AggroBot.SpamDetector.COMMON_LETTER_COMBINATIONS.join("|")})`);

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
