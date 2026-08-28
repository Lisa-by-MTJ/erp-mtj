// MTJ Channel Manager — bootstrap (Blueprint V2.0)
'use strict';
const { start } = require('./web.js');
start(Number(process.env.MTJ_PORT || 9121));
