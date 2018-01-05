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

    VPP.chats.forEach(chat => {

        const aggroBot = new AggroBot();
        aggroBot.onTypingStart = () => chat.isChatStarted() && chat.setStartedTyping();
        aggroBot.onTypingFinish = () => chat.isChatStarted() && chat.setFinishedTyping();
        aggroBot.onMessageReady = message => chat.isChatStarted() && chat.sendMessage(message);
        aggroBot.onConversationFinish = () => chat.isChatStarted() && chat.close();

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

// В целях тестирования
const AggroBase = {
    greetings: [
        "привет1",
        "привет2",
        "привет3",
        "привет4",
        "привет5"
    ],
    primary: [
        "тест1",
        "тест2",
        "тест3",
        "тест4",
        "тест5"
    ],
    secondary: [
        "т1",
        "т2",
        "т3",
        "т4",
        "т5"
    ]
};

const AggroBot = class {

    /**
     * Генерирует новое состояние бота
     */
    reset() {

        this.suspend();

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
    receiveMessage(request = "") {

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
            // Здесь и далее выбор ответа в таком виде временный и не имеет ничего общего с выбором в более поздней версии
            const queued = new AggroBot.QueuedResponse(AggroBase.greetings[Math.floor(Math.random() * AggroBase.greetings.length)]);
            queued.discardOnMessage = true;
            this._enqueueResponse(queued);
        }
        else {
            // Добавляем в очередь новый первичный ответ, если бот не занят
            if (!this._responseQueue[0]) {
                const queued = new AggroBot.QueuedResponse(AggroBase.primary[Math.floor(Math.random() * AggroBase.primary.length)]);
                queued.readDelay = AggroBot.getTimeToRead(request);
                this._enqueueResponse(queued);
                while (Math.random() < AggroBot.CHANCE_SECONDARY) {
                    const queued = new AggroBot.QueuedResponse(AggroBase.secondary[Math.floor(Math.random() * AggroBase.secondary.length)]);
                    queued.interruptOnTyping = false;
                    queued.discardOnMessage = true;
                    this._enqueueResponse(queued);
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

};

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
 * Информация о пользователе, с которым общается бот
 * @class
 */
AggroBot.UserProfile = class {

};

Object.assign(AggroBot, {

    /**
     * Возвращает время, необходимое для чтения сообщения, мс
     * @param {string} message
     * @returns {number}
     */
    getTimeToRead(message) {
        return 850 + 400 * (message + " ").match(/\s+/g).length;
    },

    /**
     * Возвращает время, необходимое для печати сообщения, мс
     * @param {string} message
     * @returns {number}
     */
    getTimeToType(message) {
        return 500 + 250 * message.length;
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
    CHANCE_SECONDARY: 0.25

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
