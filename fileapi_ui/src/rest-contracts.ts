export type RestAuthMode = "none" | "basic" | "bearer" | "api-key" | "cookie" | "login";
export type RestMethod = "GET" | "POST" | "PATCH";
export type RestVendor = "hpe" | "openbmc" | "none";

export type RestApiEntry = {
  id: string;
  name: string;
  baseUrl: string;
  defaultPath: string;
  query: { name: string; value: string }[];
  ignoreTlsErrors: boolean;
  authMode: RestAuthMode;
  vendor: RestVendor;
  username: string;
  loginPath: string;
  loginMethod: "POST" | "PATCH";
  loginBody: string;
  tokenPath: string;
  tokenHeader: string;
  tokenSendAs: string;
};

export type RestApiSecret = {
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  cookie?: string;
};

export type NativeApiResponse = {
  status: number;
  statusText?: string;
  body: number[];
  headers?: [string, string][];
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
