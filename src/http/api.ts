import axios, { AxiosResponse, Method } from "axios";
import { TypedEmitter } from "tiny-typed-emitter";
import { dummyLogger, Logger } from "ts-log";
import { isValid as isValidCountry } from "i18n-iso-countries";
import { isValid as isValidLanguage } from "@cospired/i18n-iso-languages";

import { ResultResponse, FullDeviceResponse, HubResponse, LoginResultResponse, TrustDevice, Cipher, Voice, EventRecordResponse, Invite, ConfirmInvite } from "./models"
import { HTTPApiEvents, Ciphers, FullDevices, Hubs, Voices, Invites } from "./interfaces";
import { AuthResult, EventFilterType, PublicKeyType, ResponseErrorCode, StorageType, VerfyCodeTypes } from "./types";
import { ParameterHelper } from "./parameter";
import { getTimezoneGMTString } from "./utils";
import { InvalidCountryCodeError, InvalidLanguageCodeError } from "./../error";

export class HTTPApi extends TypedEmitter<HTTPApiEvents> {

    private apiBase = "https://mysecurity.eufylife.com/api/v1";

    private username: string|null = null;
    private password: string|null = null;

    private token: string|null = null;
    private tokenExpiration: Date|null = null;
    private trustedTokenExpiration = new Date(2100, 12, 31, 23, 59, 59, 0);

    private log: Logger;
    private connected = false;

    private devices: FullDevices = {};
    private hubs: Hubs = {};

    private headers = {
        app_version: "v2.8.0_887",
        os_type: "android",
        os_version: "30",
        phone_model: "ONEPLUS A3003",
        country: "DE",
        language: "en",
        openudid: "5e4621b0152c0d00",
        uid: "",
        net_type: "wifi",
        mnc: "02",
        mcc: "262",
        sn: "75814221ee75",
        Model_type: "PHONE",
        timezone: "GMT+01:00"
    };

    constructor(username: string, password: string, log: Logger = dummyLogger) {
        super();

        this.username = username;
        this.password = password;
        this.log = log;

        this.headers.timezone = getTimezoneGMTString();
    }

    private invalidateToken(): void {
        this.token = null;
        this.tokenExpiration = null;
        axios.defaults.headers.common["X-Auth-Token"] = null;
    }

    public setPhoneModel(model: string): void {
        this.headers.phone_model = model.toUpperCase();
    }

    public getPhoneModel(): string {
        return this.headers.phone_model;
    }

    public setCountry(country: string): void {
        if (isValidCountry(country) && country.length === 2)
            this.headers.country = country;
        else
            throw new InvalidCountryCodeError("Invalid ISO 3166-1 Alpha-2 country code");
    }

    public getCountry(): string {
        return this.headers.country;
    }

    public setLanguage(language: string): void {
        if (isValidLanguage(language) && language.length === 2)
            this.headers.language = language;
        else
            throw new InvalidLanguageCodeError("Invalid ISO 639 language code");
    }

    public getLanguage(): string {
        return this.headers.language;
    }

    public async authenticate(): Promise<AuthResult> {
        //Authenticate and get an access token
        this.log.debug("Authenticate and get an access token", { token: this.token, tokenExpiration: this.tokenExpiration });
        if (!this.token || this.tokenExpiration && (new Date()).getTime() >= this.tokenExpiration.getTime()) {
            try {
                const response = await this.request("post", "passport/login", {
                    email: this.username,
                    password: this.password
                }, this.headers).catch(error => {
                    this.log.error("Error:", error);
                    return error;
                });
                this.log.debug("Response:", response.data);

                if (response.status == 200) {
                    const result: ResultResponse = response.data;
                    if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                        const dataresult: LoginResultResponse = result.data;

                        this.token = dataresult.auth_token
                        this.tokenExpiration = new Date(dataresult.token_expires_at * 1000);
                        axios.defaults.headers.common["X-Auth-Token"] = this.token;

                        if (dataresult.domain) {
                            if ("https://" + dataresult.domain + "/v1" != this.apiBase) {
                                this.apiBase = "https://" + dataresult.domain + "/v1";
                                axios.defaults.baseURL = this.apiBase;
                                this.log.info(`Switching to another API_BASE (${this.apiBase}) and get new token.`);
                                this.token = null;
                                this.tokenExpiration = null;
                                axios.defaults.headers.common["X-Auth-Token"] = null;
                                return AuthResult.RENEW;
                            }
                        }
                        this.log.debug("Token data", { token: this.token, tokenExpiration: this.tokenExpiration });
                        this.emit("connect");
                        this.connected = true;
                        return AuthResult.OK;
                    } else if (result.code == ResponseErrorCode.CODE_NEED_VERIFY_CODE) {
                        this.log.debug(`${this.constructor.name}.authenticate(): Send verification code...`);
                        const dataresult: LoginResultResponse = result.data;

                        this.token = dataresult.auth_token
                        this.tokenExpiration = new Date(dataresult.token_expires_at * 1000);
                        axios.defaults.headers.common["X-Auth-Token"] = this.token;

                        this.log.debug("Token data", { token: this.token, tokenExpiration: this.tokenExpiration });
                        await this.sendVerifyCode(VerfyCodeTypes.TYPE_EMAIL);

                        return AuthResult.SEND_VERIFY_CODE;
                    } else {
                        this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                    }
                } else {
                    this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
                }
            } catch (error) {
                this.log.error("Generic Error:", error);
            }
            return AuthResult.ERROR;
        }
        this.emit("connect");
        this.connected = true;
        return AuthResult.OK;
    }

    public async sendVerifyCode(type?: VerfyCodeTypes): Promise<boolean> {
        try {
            if (!type)
                type = VerfyCodeTypes.TYPE_EMAIL;

            const response = await this.request("post", "sms/send/verify_code", {
                message_type: type
            }, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);
            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    this.log.info(`Requested verification code for 2FA`);
                    return true;
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return false;
    }

    public async listTrustDevice(): Promise<Array<TrustDevice>> {
        try {
            const response = await this.request("get", "app/trust_device/list", undefined, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    if (result.data && result.data.list) {
                        return result.data.list;
                    }
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return [];
    }

    public async addTrustDevice(verifyCode: string): Promise<boolean> {
        try {
            const response = await this.request("post", "passport/login", {
                verify_code: `${verifyCode}`,
                transaction: `${new Date().getTime()}`
            }, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response login:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    const response2 = await this.request("post", "app/trust_device/add", {
                        verify_code: `${verifyCode}`,
                        transaction: `${new Date().getTime()}`
                    }, this.headers).catch(error => {
                        this.log.error("Error:", error);
                        return error;
                    });
                    this.log.debug("Response trust device:", response.data);

                    if (response2.status == 200) {
                        const result: ResultResponse = response2.data;
                        if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                            this.log.info(`2FA authentication successfully done. Device trusted.`);
                            const trusted_devices = await this.listTrustDevice();
                            trusted_devices.forEach((trusted_device: TrustDevice) => {
                                if (trusted_device.is_current_device === 1) {
                                    this.tokenExpiration = this.trustedTokenExpiration;
                                    this.log.debug("This device is trusted. Token expiration extended:", { tokenExpiration: this.tokenExpiration});
                                }
                            });
                            this.emit("connect");
                            this.connected = true;
                            return true;
                        } else {
                            this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                        }
                    } else if (response2.status == 401) {
                        this.invalidateToken();
                        this.log.error("Status return code 401, invalidate token", { status: response.status, statusText: response.statusText });
                    } else {
                        this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
                    }
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return false;
    }

    public async updateDeviceInfo(): Promise<void> {
        //Get the latest device info

        //Get Stations
        try {
            const response = await this.request("post", "app/get_hub_list").catch(error => {
                this.log.error("Stations - Error:", error);
                return error;
            });
            this.log.debug("Stations - Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == 0) {
                    const dataresult: Array<HubResponse> = result.data;
                    if (dataresult) {
                        dataresult.forEach(element => {
                            this.log.debug(`${this.constructor.name}.updateDeviceInfo(): stations - element: ${JSON.stringify(element)}`);
                            this.log.debug(`${this.constructor.name}.updateDeviceInfo(): stations - device_type: ${element.device_type}`);
                            this.hubs[element.station_sn] = element;
                        });
                    } else {
                        this.log.info("No stations found.");
                    }

                    if (Object.keys(this.hubs).length > 0)
                        this.emit("hubs", this.hubs);
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Stations - Generic Error:", error);
        }

        //Get Devices
        try {
            const response = await this.request("post", "app/get_devs_list").catch(error => {
                this.log.error("Devices - Error:", error);
                return error;
            });
            this.log.debug("Devices - Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == 0) {
                    const dataresult: Array<FullDeviceResponse> = result.data;
                    if (dataresult) {
                        dataresult.forEach(element => {
                            this.devices[element.device_sn] = element;
                        });
                    } else {
                        this.log.info("No devices found.");
                    }

                    if (Object.keys(this.devices).length > 0)
                        this.emit("devices", this.devices);
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Devices - Generic Error:", error);
        }
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public async request(method: Method, endpoint: string, data?: any, headers?: any): Promise<AxiosResponse<any>> {

        if (!this.token && endpoint != "passport/login") {
            //No token get one
            switch (await this.authenticate()) {
                case AuthResult.RENEW:
                    this.log.debug("Renew token", { method: method, endpoint: endpoint });
                    await this.authenticate();
                    break;
                case AuthResult.ERROR:
                    this.log.error("Token error", { method: method, endpoint: endpoint });
                    break;
                default: break;
            }
        }
        if (this.tokenExpiration && (new Date()).getTime() >= this.tokenExpiration.getTime()) {
            this.log.info("Access token expired; fetching a new one")
            this.invalidateToken();
            if (endpoint != "passport/login")
                //get new token
                await this.authenticate()
        }

        this.log.debug("Request:", { method: method, endpoint: endpoint, baseUrl: this.apiBase, token: this.token, data: data, headers: this.headers });
        const response = await axios({
            method: method,
            url: endpoint,
            data: data,
            headers: headers,
            baseURL: this.apiBase,
            validateStatus: function (status) {
                return status < 500; // Resolve only if the status code is less than 500
            }
        });

        if (response.status == 401) {
            this.invalidateToken();
            this.log.error("Status return code 401, invalidate token", { status: response.status, statusText: response.statusText });
            this.emit("close");
            this.connected = false;
        }

        return response;
    }

    public async checkPushToken(): Promise<boolean> {
        //Check push notification token
        try {
            const response = await this.request("post", "/app/review/app_push_check", {
                app_type: "eufySecurity",
                transaction: `${new Date().getTime()}`
            }, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == 0) {
                    this.log.debug(`Push token OK`);
                    return true;
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else if (response.status == 401) {
                this.invalidateToken();
                this.log.error("Status return code 401, invalidate token", { status: response.status, statusText: response.statusText });
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return false;
    }

    public async registerPushToken(token: string): Promise<boolean> {
        //Register push notification token
        try {
            const response = await this.request("post", "/apppush/register_push_token", {
                is_notification_enable: true,
                token: token,
                transaction: `${new Date().getTime().toString()}`
            }, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == 0) {
                    this.log.debug(`Push token registered successfully`);
                    return true;
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else if (response.status == 401) {
                this.invalidateToken();
                this.log.error("Status return code 401, invalidate token", { status: response.status, statusText: response.statusText });
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return false;
    }

    public async setParameters(stationSN: string, deviceSN: string, params: { paramType: number; paramValue: any; }[]): Promise<boolean> {
        const tmp_params: any[] = []
        params.forEach(param => {
            tmp_params.push({ param_type: param.paramType, param_value: ParameterHelper.writeValue(param.paramType, param.paramValue) });
        });

        try {
            const response = await this.request("post", "app/upload_devs_params", {
                device_sn: deviceSN,
                station_sn: stationSN,
                params: tmp_params
            }).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", { stationSN: stationSN, deviceSN: deviceSN, params: tmp_params, response: response.data });

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == 0) {
                    const dataresult = result.data;
                    this.log.debug("New parameters set", {params: tmp_params, response: dataresult });
                    return true;
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return false;
    }

    public async getCiphers(cipherIDs: Array<number>, userID: string): Promise<Ciphers> {
        try {
            const response = await this.request("post", "app/cipher/get_ciphers", {
                cipher_ids: cipherIDs,
                user_id: userID,
                transaction: `${new Date().getTime().toString()}`
            }, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    if (result.data) {
                        const ciphers: Ciphers = {};
                        result.data.forEach((cipher: Cipher) => {
                            ciphers[cipher.cipher_id] = cipher;
                        });
                        return ciphers;
                    }
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return {};
    }

    public async getVoices(deviceSN: string): Promise<Voices> {
        try {
            const response = await this.request("get", `voice/response/lists/${deviceSN}`, null, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    if (result.data) {
                        const voices: Voices = {};
                        result.data.forEach((voice: Voice) => {
                            voices[voice.voice_id] = voice;
                        });
                        return voices;
                    }
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return {};
    }

    public async getCipher(cipherID: number, userID: string): Promise<Cipher> {
        return (await this.getCiphers([cipherID], userID))[cipherID];
    }

    public getLog(): Logger {
        return this.log;
    }

    public getDevices(): FullDevices {
        return this.devices;
    }

    public getHubs(): Hubs {
        return this.hubs;
    }

    public getToken(): string|null {
        return this.token;
    }

    public getTokenExpiration(): Date|null {
        return this.tokenExpiration;
    }

    public getTrustedTokenExpiration(): Date {
        return this.trustedTokenExpiration;
    }

    public setToken(token: string): void {
        this.token = token;
        axios.defaults.headers.common["X-Auth-Token"] = token;
    }

    public setTokenExpiration(tokenExpiration: Date): void {
        this.tokenExpiration = tokenExpiration;
    }

    public getAPIBase(): string {
        return this.apiBase;
    }

    public setAPIBase(apiBase: string): void {
        this.apiBase = apiBase;
    }

    public setOpenUDID(openudid: string): void {
        this.headers.openudid = openudid;
    }

    public setSerialNumber(serialnumber: string): void {
        this.headers.sn = serialnumber;
    }

    private async _getEvents(functionName: string, endpoint: string, startTime: Date, endTime: Date, filter?: EventFilterType, maxResults?: number): Promise<Array<EventRecordResponse>> {
        const records: Array<EventRecordResponse> = [];
        try {
            if (filter === undefined)
                filter = { deviceSN: "", stationSN: "", storageType: StorageType.NONE };
            if (maxResults === undefined)
                maxResults = 1000;

            const response = await this.request("post", endpoint, {
                device_sn: filter.deviceSN !== undefined ? filter.deviceSN : "",
                end_time: Math.trunc(endTime.getTime() / 1000),
                id: 0,
                id_type: 1,
                is_favorite: false,
                num: maxResults,
                pullup: true,
                shared: true,
                start_time: Math.trunc(startTime.getTime() / 1000),
                station_sn: filter.stationSN !== undefined ? filter.stationSN : "",
                storage: filter.storageType !== undefined ? filter.storageType : StorageType.NONE,
                transaction: `${new Date().getTime().toString()}`
            }, this.headers).catch(error => {
                this.log.error(`${functionName} - Error:`, error);
                return error;
            });
            this.log.debug(`${functionName} - Response:`, response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == 0) {
                    const dataresult: Array<EventRecordResponse> = result.data;
                    if (dataresult) {
                        dataresult.forEach(record => {
                            this.log.debug(`${functionName} - Record:`, record);
                            records.push(record);
                        });
                    }
                } else {
                    this.log.error(`${functionName} - Response code not ok`, {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error(`${functionName} - Status return code not 200`, { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error(`${functionName} - Generic Error:`, error);
        }
        return records;
    }

    public async getVideoEvents(startTime: Date, endTime: Date, filter?: EventFilterType, maxResults?: number): Promise<Array<EventRecordResponse>> {
        return this._getEvents("getVideoEvents", "event/app/get_all_video_record", startTime, endTime, filter, maxResults);
    }

    public async getAlarmEvents(startTime: Date, endTime: Date, filter?: EventFilterType, maxResults?: number): Promise<Array<EventRecordResponse>> {
        return this._getEvents("getAlarmEvents", "event/app/get_all_alarm_record", startTime, endTime, filter, maxResults);
    }

    public async getHistoryEvents(startTime: Date, endTime: Date, filter?: EventFilterType, maxResults?: number): Promise<Array<EventRecordResponse>> {
        return this._getEvents("getHistoryEvents", "event/app/get_all_history_record", startTime, endTime, filter, maxResults);
    }

    public async getAllVideoEvents(filter?: EventFilterType, maxResults?: number): Promise<Array<EventRecordResponse>> {
        const fifthyYearsInMilliseconds = 15 * 365 * 24 * 60 * 60 * 1000;
        return this.getVideoEvents(new Date(new Date().getTime() - fifthyYearsInMilliseconds), new Date(), filter, maxResults);
    }

    public async getAllAlarmEvents(filter?: EventFilterType, maxResults?: number): Promise<Array<EventRecordResponse>> {
        const fifthyYearsInMilliseconds = 15 * 365 * 24 * 60 * 60 * 1000;
        return this.getAlarmEvents(new Date(new Date().getTime() - fifthyYearsInMilliseconds), new Date(), filter, maxResults);
    }

    public async getAllHistoryEvents(filter?: EventFilterType, maxResults?: number): Promise<Array<EventRecordResponse>> {
        const fifthyYearsInMilliseconds = 15 * 365 * 24 * 60 * 60 * 1000;
        return this.getHistoryEvents(new Date(new Date().getTime() - fifthyYearsInMilliseconds), new Date(), filter, maxResults);
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public async getInvites(): Promise<Invites> {
        try {
            const response = await this.request("post", "family/get_invites", {
                num: 100,
                orderby: "",
                own: false,
                page: 0,
                transaction: `${new Date().getTime().toString()}`
            }, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    if (result.data) {
                        const invites: Invites = {};
                        result.data.forEach((invite: Invite) => {
                            invites[invite.invite_id] = invite;
                            invites[invite.invite_id].devices = JSON.parse((invites[invite.invite_id].devices as unknown) as string);
                        });
                        return invites;
                    }
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return {};
    }

    public async confirmInvites(confirmInvites: Array<ConfirmInvite>): Promise<boolean> {
        try {
            const response = await this.request("post", "family/confirm_invite", {
                invites: confirmInvites,
                transaction: `${new Date().getTime().toString()}`
            }, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    return true;
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return false;
    }

    public async getPublicKey(deviceSN: string, type: PublicKeyType): Promise<string> {
        try {
            const response = await this.request("get", `public_key/query?device_sn=${deviceSN}&type=${type}`, null, this.headers).catch(error => {
                this.log.error("Error:", error);
                return error;
            });
            this.log.debug("Response:", response.data);

            if (response.status == 200) {
                const result: ResultResponse = response.data;
                if (result.code == ResponseErrorCode.CODE_WHATEVER_ERROR) {
                    if (result.data) {
                        return result.data.public_key;
                    }
                } else {
                    this.log.error("Response code not ok", {code: result.code, msg: result.msg });
                }
            } else {
                this.log.error("Status return code not 200", { status: response.status, statusText: response.statusText });
            }
        } catch (error) {
            this.log.error("Generic Error:", error);
        }
        return "";
    }

}