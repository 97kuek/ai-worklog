import { createApp } from "./app";
import { createAccessAuthenticator } from "./auth/access";
import { fetchAccessKeys } from "./auth/keys";

export default createApp({ authenticate: createAccessAuthenticator(fetchAccessKeys) });
