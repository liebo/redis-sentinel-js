var redis = require("redis");
var EventEmitter = require('events').EventEmitter;
var net = require("net");
var _ = require("underscore");
var NegotiatorClient = require("./negotiator_client.js");

module.exports = Monitor;

/**
 *  The abstract client to the sentinel cluster.  Monitors sentinels
 *  in order to preserve the state of the redis cluster accoss individual
 *  redis clients.
 *
 *  @param {object} options
 *      A dictionary of the options determining the settings for the redis cluster
 *      options.ports => an array of port numbers indicating how to connect to sentinels
 *      options.host => a string indicating the host to connect to
 */
function Monitor( options ) {

    var self = this;
    EventEmitter.call(this);

    var defaults = {
        host: 'localhost',
        ports: [26379]
    }
    var settings = {};

    // NegotiatorClients to each master instance
    var clients = this.clients = {};
    // the redis client to each sentinel
    var sentinel_clients = this.sentinel_clients = [];
    // The config info for each master redis instance
    var masters = this.masters = {};
    // contains arrays of information on the slave instances. Grouped by mastername.
    var slaves = this.slaves = {};

    this.current_sentinel = null;
    this.current_subscription = null;

    _.extend(settings, defaults, options);

    for (var port_index in settings.ports) {
        sentinel_clients.push(redis.createClient(settings.ports[port_index], settings.host));
    }

    var clusters_expected = 0;
    var clusters_loaded = 0;

    this.sync = function() {
        clusters_expected = 0;
        clusters_loaded = 0;
        negotiate_current_sentinel();
    }

    ////////////////////////////////

    var SUBSCRIPTION_HANDLES = {
        '+sdown': on_sub_down,
        '-sdown': on_sub_up,
        '+odown': on_obj_down,
        '-odown': on_obj_up,
        '+sentinel': on_new_sentinel,
        '+slave': on_new_slave,
        '+switch-master': on_switch_master,
        '+reboot': on_reboot_instance
    }

    function on_obj_down (info) {
        if (info.type == 'master') self.get_client(info.name).enter_failsafe_state();
        else {
            // TODO: handle sentinels and slaves--nothing to do here yet
        }
    }

    function on_obj_up (info) {
        if (info.type == 'master') self.get_client(info.name).exit_failsafe_state();
        else {
            // TODO: handle sentinels and slaves--nothing to do here yet
        }
    }

    // change these for different behavior on +-subdown
    function on_sub_down (info) {
        return on_obj_down(info);
    }
    function on_sub_up (info) {
        return on_obj_up(info);
    }

    function on_new_slave (info) {
        load_slave_list(info.master_name);
    }

    function on_new_sentinel (info) {
        add_sentinel(info.host, info.port);
    }

    // does nothing.  Should be handled by subdown/odown.
    function on_reboot_instance (info) {
        console.log(info.type + ' just rebooted');
    }

    function add_sentinel (host, port) {
        if (!does_sentinel_exist(host, port)) {
            sentinel_clients.push(redis.createClient(port, host));
        }
    }

    function on_switch_master(){}

    function does_sentinel_exist (host, port) {
        return _.any(sentinel_clients, function (sentinel) {
            return sentinel.host === host && sentinel.port === port;
        })
    }

    function negotiate_current_sentinel (num_trials) {

        num_trials = num_trials || 0;
        if (num_trials >= sentinel_clients.length) self.emit('alldown');

        self.current_sentinel = self.current_sentinel || sentinel_clients[0];

        self.current_sentinel.ping( function( error, response ) {
            // TODO: check against possible responses to ping
            if (!error) {
                clusters_expected = response.length;
                subscribe_to_sentinel(self.current_sentinel);
                sentinel_negotiated();
                return;
            }
            var new_sentinel_index = (get_current_sentinel_index() + 1) % sentinel_clients.length;
            self.current_sentinel = sentinel_clients[new_sentinel_index];
            negotiate_current_sentinel(num_trials + 1);
        });
    }

    function get_current_sentinel_index() {
        return sentinel_clients.indexOf(self.current_sentinel);
    }

    function load_master_list() {
        self.current_sentinel.send_command('sentinel', ['masters'], function (err, response) {
            // TODO: handle error here
            for (var i = 0; i < response.length; i++) {
                var master_config = unflatten_hash(response[i]);
                masters[master_config.name] = master_config;
                master_config_loaded( master_config.name );
            }
        });
    }

    function load_slave_list(master_name) {
        self.current_sentinel.send_command('sentinel', ['slaves', master_name], function (err, response) {
            // TODO: handle error here
            slaves[master_name] = [];
            // convert flattened key/value array to a js object
            for (var i = 0; i < response.length; i++) {
                slaves[master_name][i] = unflatten_hash(response[i]);
            }
            cluster_ready(master_name);
        });
    }

    function on_cluster_config_loaded() {
        clusters_loaded++;
        if (clusters_loaded == clusters_expected) sync_complete();
    }
    
    //**** EVENTS ****//
    self.on('sentinel_negotiated', load_master_list);
    self.on('master_config_loaded', load_slave_list);
    self.on('cluster_ready', on_cluster_config_loaded);
    function all_sentinels_down() {
        self.emit('all_down');
    }
    function master_config_loaded(master_name) {
        self.emit('master_config_loaded', master_name);
    }
    function cluster_ready(master_name) {
        self.emit('cluster_ready', master_name);
    }
    function sync_complete() {
        self.emit('sync_complete');
    }
    function sentinel_negotiated() {
        self.emit('sentinel_negotiated');
    }

    function unflatten_hash (arr) {
        // turns an array of sequential key value pairs (e.g. ['one', '1', 'two', '2']) into a hash (e.g. { one: '1', two: '2' })
        var out = {};
        for (var i = 0; i < arr.length; i += 2) {
            out[arr[i]] = arr[i + 1];
        }
        return out;
    }

    this.get_client = function (master_name) {
        console.log('masters are::::', masters);

        if (clients[master_name]) return clients[master_name];

        var port = parseInt(masters[master_name].port);
        var host = masters[master_name].ip;
        var nc = new NegotiatorClient(master_name, port, host, slaves[master_name]);

        clients[master_name] = nc;
        return clients[master_name];
    }

    function subscribe_to_sentinel (sentinel) {
        delete self.current_subscription;
        self.current_subscription = redis.createClient(sentinel.remotePort, sentinel.remoteAddress);
        self.current_subscription.subscribe('all');
        //sentinel.on('error', function(){});
        //sentinel.on('end', function(){});
        self.current_subscription.on('message', handle_sentinel_message);
    }

    function handle_sentinel_message (channel, message) {
        console.log(channel, message);
        if ( !(message && typeof message.data == 'string') ) return;

        var handler = SUBSCRIPTION_HANDLES[message['channel']];
        if ( typeof handler != 'function' ) return;
        handler( parse_instance_info(message['data']) );
    }

    function parse_instance_info (infoStr) {
        var tokens = infoStr.split();
        var info = {
            type: tokens[0],
            name: tokens[1],
            host: tokens[2],
            port: tokens[3]
        };
        if (info.type == 'slave') info.master_name = tokens[5];
        return info;
    }
}
Monitor.prototype.__proto__ = EventEmitter.prototype;
