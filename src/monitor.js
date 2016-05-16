let debug = require('debug')('taskcluster-lib-monitor');
let _ = require('lodash');
let assert = require('assert');
let Promise = require('promise');
let taskcluster = require('taskcluster-client');
let raven = require('raven');
let utils = require('./utils');
let Statsum = require('statsum');

class Monitor {

  constructor (authClient, sentry, statsumClient, opts) {
    this._opts = opts;
    this._auth = authClient;
    this._sentry = sentry; // This must be a Promise that resolves to {client, expires}
    this._statsum = statsumClient;

    if (!opts.isPrefixed && opts.reportStatsumErrors) {
      this._statsum.on('error', err => this.reportError(err, 'warning'));
    }

    if (!opts.isPrefixed && opts.patchGlobal) {
      process.on('uncaughtException', (err) => {
        console.log(err.stack);
        this.reportError(err);
        process.exit(1);
      });
      process.on('unhandledRejection', (reason, p) => {
        let err = 'Unhandled Rejection at: Promise ' + p + ' reason: ' + reason;
        console.log(err);
        this.reportError(err, 'warning');
      });
    }
  }

  async reportError (err, level='error') {
    this._sentry = this._sentry.then(async (sentry) => {
      if (!sentry.expires || Date.parse(sentry.expires) <= Date.now()) {
        let sentryInfo = await this._auth.sentryDSN(this._opts.project);
        return {
          client: new raven.Client(sentryInfo.dsn.secret),
          expires: sentryInfo.expires,
        };
      }
      return sentry;
    }).catch(err => {});

    this._sentry.then(sentry => {
      sentry.client.captureException(err, {level});
    });
  }

  // captureError is an alias for reportError to match up
  // with the raven api better.
  async captureError (err, level='error') {
    this.reportError(err, level);
  }

  count (key, val) {
    this._statsum.count(key, val || 1);
  }

  measure (key, val) {
    this._statsum.measure(key, val);
  }

  async flush () {
    await this._statsum.flush();
  }

  prefix (prefix) {
    let newopts = _.cloneDeep(this._opts);
    newopts.isPrefixed = true;
    return new Monitor(
      this._auth,
      this._sentry,
      this._statsum.prefix(prefix),
      newopts
    );
  }

  timedHandler (name, handler) {
    return utils.timedHandler(this, name, handler);
  }

  expressMiddleware (name) {
    return utils.expressMiddleware(this, name);
  }

  resources (process, interval = 60) {
    return utils.resources(this, process, interval);
  }
}

class MockMonitor {
  constructor (opts, counts = {}, measures = {}, errors = []) {
    this._opts = opts;
    this.counts = counts;
    this.measures = measures;
    this.errors = errors;
  }

  async reportError (err, level='error') {
    this.errors.push(err);
  }

  async captureError (err, level='error') {
    this.reportError(err, level);
  }

  count (key, val) {
    let k = this._key(key);
    this.counts[k] = (this.counts[k] || 0) + (val || 1);
  }

  measure (key, val) {
    let k = this._key(key);
    assert(typeof val === 'number', 'Measurement value must be a number');
    this.measures[k] = (this.measures[k] || []).concat(val);
  }

  timedHandler (name, handler) {
    return async (message) => { await handler(message); };
  }

  expressMiddleware (name) {
    return (req, res, next) => {
      next();
    };
  }

  _key (key) {
    let p = '.';
    if (this._opts.prefix) {
      p = this._opts.prefix + '.';
    }
    return this._opts.project + p + key;
  }

  async flush () {
    // Do nothing.
  }

  prefix (prefix) {
    let newopts = _.cloneDeep(this._opts);
    newopts.prefix = (this._opts.prefix || '')  + '.' + prefix;
    return new MockMonitor(
      newopts,
      this.counts,
      this.measures,
      this.errors
    );
  }

  timedHandler (name, handler) {
    return utils.timedHandler(this, name, handler);
  }

  expressMiddleware (name) {
    return utils.expressMiddleware(this, name);
  }

  resources (process, interval = 60) {
    return utils.resources(this, process, interval);
  }
}

async function monitor (options) {
  assert(options.credentials, 'Must provide taskcluster credentials!');
  assert(options.project, 'Must provide a project name!');
  let opts = _.defaults(options, {
    patchGlobal: true,
    reportStatsumErrors: true,
    isPrefixed: false,
  });

  if (options.mock) {
    return new MockMonitor(opts);
  }

  let authClient = new taskcluster.Auth({
    credentials: options.credentials,
  });

  let statsumClient = new Statsum(
    project => authClient.statsumToken(project),
    {
      project: opts.project,
      emitErrors: opts.reportStatsumErrors,
    }
  );

  let sentry = Promise.resolve({client: null, expires: new Date(0)});

  return new Monitor(authClient, sentry, statsumClient, opts);
};

module.exports = monitor;
