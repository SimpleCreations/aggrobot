// ==VPPScript==
// @name            AggroBot
// @version         0.1.0
// @script-filename aggrobot.vpp.js
// @update-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/Release-1/update.json
// @script-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/Release-1/aggrobot.vpp.js
// @database-url    https://raw.githubusercontent.com/SimpleCreations/aggrobot/Release-1/database.json
// ==/VPPScript==

const log = message => VPP.chats[0].log(`[AggroBot] ${message}`);

log("Проверка обновлений...");
$.ajax({
    url: VPPScript.meta["update-url"],
    dataType: "json",
    cache: false
})
    .pipe(response => response["script_version"] ? response : $.Deferred().reject())
    .done(response => {

        log(response["script_version"] > VPPScript.meta["version"] ?

            `Вы используете устаревший скрипт.<br>
Текущая версия: ${VPPScript.meta["version"]}<br>
Последняя версия: ${response["script_version"]}<br>
Введите "/aggrobot download", чтобы скачать последнюю версию.` :

            `Вы используете последнюю версию скрипта.`

        );

        if (!response["database_version"]) return log("Не удалось получить последнюю версию базы сообщений.");
        const currentDatabaseVersion = VPPScript.storage.databaseVersion;
        if (!currentDatabaseVersion || response["database_version"] > currentDatabaseVersion) {

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
         * Информация о пользователе
         * @type {AggroBot.UserProfile}
         * @private
         */
        this._userProfile = new AggroBot.UserProfile();

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
        clearTimeout(this._typeTimeout);
        clearTimeout(this._interruptedTimeout);
        clearTimeout(this._activityCheckTimeout);

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
            this._getResponse("greetings").forEach(response => {
                const queued = new AggroBot.QueuedResponse(response);
                queued.discardOnMessage = true;
                this._enqueueResponse(queued);
            });
        }
        else {
            // Добавляем в очередь новый первичный ответ, если бот не занят
            if (!this._responseQueue[0]) {
                this._getResponse("primary").forEach((response, index) => {
                    const queued = new AggroBot.QueuedResponse(response);
                    if (!index) queued.readDelay = AggroBot.getTimeToRead(request);
                    this._enqueueResponse(queued);
                });
                while (Math.random() < AggroBot.CHANCE_SECONDARY) {
                    this._getResponse("secondary").forEach(response => {
                        const queued = new AggroBot.QueuedResponse(response);
                        queued.interruptOnTyping = false;
                        queued.discardOnMessage = true;
                        this._enqueueResponse(queued);
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
            this._inactivityCounter++;
            // Временно
            if (this._inactivityCounter >= 3) this.onConversationFinish();
            else this.prepareResponse();
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
     * Возвращает случайный ответ из базы сообщений по ключу
     * @param {string} databaseKey
     * @returns {Array<string>}
     * @private
     */
    _getResponse(databaseKey) {

        const string = this._database[databaseKey].getRandom().string;
        const result = [];

        // Парсим функции и флаги внутри сообщения
        // Временно: удаляем $
        const message = string.replace(/%(\w+)(?:\(([^,)]*(?:,[^,)]*)*)\))?/g, (_, name, args) => {

            args = args ? args.split(",") : [];

            switch (name) {
                case "g":
                case "gender":
                    return (this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ? args[0] : args[1]) || "";
            }

            return "";

        }).replace(/[$@]\w+/g, "");

        // Обрабатываем разбиения
        message.split(" // ").forEach(part => {
            let buffer;
            part.split(" / ").forEach(part => {
                if (!buffer) buffer = part;
                else if (Math.random() < AggroBot.getSplitChanceByCurrentPart(buffer)) {
                    result.push(buffer);
                    buffer = part;
                }
                else buffer += part;
            });
            result.push(buffer);
        });

        return result;

    }

    /**
     * Пытается определить пол по сообщению и записать в профиль
     * @param message
     * @private
     */
    _determineGender(message) {

        let gender;
        if (/(^|[^а-яё])(я?([мmп]|парень?|пацан|мальчик|муж(ик|чина)?)|я\s+[а-яё]+(ый|л))($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|^[^а-яё]*((я|меня)\s+)?(Александр|Алексей|Леша|Леха|Андрей|Антон|Артем|Артур|Ваня|Василий|Вася|Виктор|Витя|Виталий|Владимир|Вова|Влад|Глеб|Григорий|Гриша|Даниил|Данила|Денис|Дмитрий|Дима|Евгений|Егор|Иван|Игорь|Илья|Кирилл|Костя|Макс|Матвей|Михаил|Миша|Никита|Николай|Коля|Олег|Павел|Паша|Рома|Семен|Сема|Сергей|Стас|Тимур|Юрий|Юра)[^а-яё?]*$/i.test(message)) {
            gender = AggroBot.UserProfile.Gender.MALE;
        }
        else if (/(^|[^а-яё])(я?([жд]|дев(оч|ч[ео]н|уш)ка|женщина|баба|телка|тянк?а?)|я\s+[а-яё]+ая?)($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|^[^а-яё]*((я|меня)\s+)?(Александра|Алина|Алиса|Алла|Анастасия|Настя|Анна|Аня|Валерия|Вера|Виктория|Вика|Галя|Дарья|Даша|Диана|Ева|Евгения|Екатерина|Катя|Елена|Лена|Елизавета|Лиза|Ира|Ирина|Карина|Кира|Кристина|Ксения|Ксюша|Лариса|Лида|Лилия|Люба|Людмила|Люда|Маргарита|Рита|Марина|Мария|Маша|Милена|Надежда|Надя|Наталья|Наташа|Ника|Нина|Оксана|Олеся|Ольга|Оля|Полина|Светлана|Света|Софья|Соня|Татьяна|Таня|Ульяна|Юлия|Юля|Яна)[^а-яё?]*$/i.test(message)) {
            gender = AggroBot.UserProfile.Gender.FEMALE;
        }

        if (gender !== undefined) {
            this._userProfile.gender = gender;
            this.onReport("Определён пол: " + (gender === AggroBot.UserProfile.Gender.MALE ? "мужской" : "женский"));
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
     * Вероятность написания первичного ответа
     */
    CHANCE_SECONDARY: 0.275,

    /**
     * Возвращает вероятность разбиения сообщения при переданной текущей неразбитой части
     * @param message
     * @returns {number}
     */
    getSplitChanceByCurrentPart(message) {
        return 2 / (1 + Math.exp(-0.044 * message.length)) + 1
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

        Object.keys(this).forEach(key => this[key].reset());

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
     * Генерирует новое состояние ответов
     */
    reset() {

        this._totalAvailable = this._array.length;
        this._array.forEach(response => response.used = false);

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
         * Пол
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

    VPP.chats.forEach(chat => chat.removeEventListener("aggrobot"));
    delete VPP.Chat.prototype.aggrobot;

};
