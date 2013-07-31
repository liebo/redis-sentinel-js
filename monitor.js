var EventEmitter = require('events').EventEmitter;
var net = require("net");

var MasterClient = require("./master_client.js");
var redis = require("redis");
var _ = require("underscore");
var logger = require('./logger.js');

module.exports = Monitor;
Monitor.setLogger = logger.setLogger.bind(logger);

/**
 *  The abstract client to the sentinel cluster.  Monitors sentinels
 *  in order to preserve the state of the redis cluster accoss individual
 *  redis clients.
 *
 *  @param {Object} options
 *      A dictionary of the options determining the settings for the redis cluster
 *      options.hosts => a string indicating the host:port to connect to
 *      options.timeout => the timeout for queued requests wating for failover to finish
 */
function Monitor( options ) {

    EventEmitter.call(this);

    var defaults = {
        hosts: ['localhost:23679'],
        failover_timeout: 5000
    };

    var settings = {};
    _.extend(settings, defaults, options);
    this.options = settings;

    this.sentinel_client = null;
    this.master_clients = {};

    this.sentinels = [];
    this.masters = {};
    this.slaves = {};

    this.current_sentinel = null;
    this.current_subscription = null;

    this.SUBSCRIPTION_HANDLES = {
        '+sdown': this.on_sub_down.bind(this),
        '-sdown': this.on_sub_up.bind(this),
        '+odown': this.on_obj_down.bind(this),
        '-odown': this.on_obj_up.bind(this),
        '+sentinel': this.on_new_sentinel.bind(this),
        '+slave': this.on_new_slave.bind(this),
        '+switch-master': this.on_switch_master.bind(this),
        '+reboot': this.on_reboot_instance.bind(this)
    };

    this.sentinel_connection_trials = 0;
    this.clusters_expected = 0;
    this.clusters_loaded = 0;

    for (var hosts_index = 0; hosts_index < settings.hosts.length; ++hosts_index) {
        var host_and_port = settings.hosts[hosts_index].split(':');
        this.add_sentinel(parseInt(host_and_port[1]), host_and_port[0], true);
    }

    // Connects to a random sentinel. TODO: robustness;
    //var sentinel_to_connect_to = parseInt(Math.random() * settings.hosts.length);
    //this.sentinel_client = this.connect_to_sentinel(0);

    //**** EVENTS ****//
    this.on('sentinel_selected', this.load_master_list);
    this.on('master_config_loaded', this.load_slave_list);
    this.on('cluster_ready', this.cluster_config_loaded);

};

Monitor.prototype.sync = function() {
    this.clusters_expected = 0;
    this.clusters_loaded = 0;
    this.select_current_sentinel();
};

Monitor.prototype.__proto__ = EventEmitter.prototype;

/**
 * Returns the master client abstraction used to maintain high availability
 * connection to the redis cluster. If a MasterClient exists by the given
 * name, return that client.  Else create one and store it in the 'clients' hash.
 *
 * @param {string} master_name The name given to the cluster by the sentinels.
 * @return {MasterClient} The requested MasterClient.
 */
Monitor.prototype.get_client = function(master_name) {
    var mc = this.master_clients[master_name];

    if (mc) return mc;
    
    if (!this.synced){
        mc = this.create_master_client(master_name, null, null, null, failover_timeout);
        this.master_clients[master_name] = mc;
        return mc;
    }

    var config = this.masters[master_name];
    // Do we really want to throw an error here?
    if (!config) throw new Error("Sentinels cannot find master: " + master_name);

    var port = parseInt(config.port);
    var host = config.ip;
    var slaves = this.slaves[master_name];
    var timeout = this.failover_timeout;
    mc = this.create_master_client(master_name, port, host, slaves, timeout);
    this.master_clients[master_name] = mc;
    return mc;
};

/**
 * Creates a MasterClient instance. Overridden in test.
 */
Monitor.prototype.create_master_client = function(master_name, port, host, slaves, failover_timeout) {
    return new MasterClient( master_name, port, host, slaves, failover_timeout );
};

/**
 * Sets the current sentinel to the first active sentinel provided by
 * the options argument.
 */
Monitor.prototype.select_current_sentinel = function() {
    if (!this.sentinel_client) this.connect_to_sentinel(0);
    if (this.sentinel_client.connected) return;
    // TODO: may be able to bubble this event up to the sentinel
    // listing on sentinel error and connect events could greatly
    // simplify this flow
    this.sentinel_client.once('connect', onconnect.bind(this));
    this.sentinel_client.once('error', onerror.bind(this));
};
function onconnect() {
    logger.unsquelch();
    logger.info('Connected to sentinel at '+this.sentinel_client.host+':'+this.sentinel_client.port);
    this.sentinel_connection_trials = 0;
    this.subscribe_to_sentinel(this.current_sentinel);
    this.sentinel_selected();
};
function onerror() {
    var new_sentinel_index = (this.get_current_sentinel_index() + 1) % this.sentinels.length;
    if (this.sentinel_connection_trials >= this.sentinels.length) {
        this.all_sentinels_down();
    } else {
        this.connect_to_sentinel(new_sentinel_index);
        this.sentinel_connection_trials++;
        this.select_current_sentinel();
    }
};

Monitor.prototype.connect_to_sentinel = function(index) {
    var config = this.sentinels[index],
        port = config.port,
        host = config.host;
    this.current_sentinel = config;
    this.sentinel_client = redis.createClient(port, host)
        .on('error', function(e){logger.error(e.message)});
}

Monitor.prototype.get_current_sentinel_index = function() {
    var cs = this.current_sentinel;
    return this.get_sentinel_index(cs.port, cs.host);
};
Monitor.prototype.get_sentinel_index = function(port, host) {
    return get_client_index(port, host, this.sentinels);
}

Monitor.prototype.add_sentinel = function(port, host, skip_check_if_exists) {
    if ( skip_check_if_exists || !(1+this.get_sentinel_index(port, host)) ) {
        this.sentinels.push({port: port, host: host});
    }
}
/**
 *  Subscribes to the given sentinel's pubsub events.
 *
 *  @param {RedisClient} sentinel_client The client object connected to the desired sentinel.
 */
Monitor.prototype.subscribe_to_sentinel = function(sentinel_client) {
    delete this.current_subscription;

    this.current_subscription = redis.createClient(sentinel_client.port, sentinel_client.host)
        .on('error', function(e){logger.error(e.message)});
    logger.info(this.current_subscription._events);
    this.current_subscription.psubscribe('*');
    //sentinel.on('error', function(){});
    //sentinel.on('end', function(){});
    this.current_subscription.on('pmessage', handle_sentinel_message.bind(this));
};

/**
 *  Requests list of masters from the sentinel and stores it.
 */
Monitor.prototype.load_master_list = function() {
    this.sentinel_client.send_command( 'sentinel', ['masters'], handle_master_list_response.bind(this));
};
function handle_master_list_response(err, response) {
    this.clusters_expected = response.length;
    for (var i = 0; i < response.length; i++) {
        var master_config = unflatten_hash(response[i]);
        this.masters[master_config.name] = master_config;
        this.master_config_loaded( master_config.name );
    }
}

/**
 *  For the named master instance, requests list of slaves from the sentinel and stores it.
 *
 *  @param {string} master_name The name of the redis cluster from which to request the slave list.
 */
Monitor.prototype.load_slave_list = function(master_name) {
    this.sentinel_client.send_command('sentinel', ['slaves', master_name], handle_slave_list_response.bind(this, master_name));
};
function handle_slave_list_response(master_name, err, response) {

    // TODO: handle error here
    if (this.slaves[master_name]) this.slaves[master_name].length = 0;
    else this.slaves[master_name] = [];
    
    for (var i = 0; i < response.length; i++) {
        this.slaves[master_name][i] = unflatten_hash(response[i]);
    }
    this.cluster_ready(master_name);
}

Monitor.prototype.add_slave = function(port, host, master_name, skip_check_if_exists) {
    if ( skip_check_if_exists || !(1+this.get_slave_index(port, host, master_name)) ) {
        this.slaves[master_name].push({port: port, host: host});
    }
}
Monitor.prototype.remove_slave = function(port, host, master_name) {
    var slave_index = this.get_slave_index(port, host, master_name);
    if (slave_index + 1) this.slaves[master_name].splice(slave_index, 1);
}
Monitor.prototype.get_slave_index = function(port, host, master_name) {
    return get_client_index(port, host, this.slaves[master_name]);
};


Monitor.prototype.cluster_config_loaded = function() {
    this.clusters_loaded++;
    if (this.clusters_loaded == this.clusters_expected) this.sync_complete();
}


/**** Event emiter wrapper functions ****/
Monitor.prototype.all_sentinels_down = function() {
    logger.warn('ALL SENTINELS DOWN');
    logger.squelch();
    setTimeout( function() {
        logger.forceInfo('Retrying sentinel connections');
        this.sentinel_connection_trials = 0;
        this.connect_to_sentinel(0);
        this.select_current_sentinel();
    }.bind(this), 5000);
    this.emit('all_down');
};
// right now these are extraneous in case someone wanted to listen for
// individual load events. May not necessarily want that.
Monitor.prototype.master_config_loaded = function(master_name) {
    logger.debug('Found master: '+master_name);
    this.emit('master_config_loaded', master_name);
};
Monitor.prototype.cluster_ready = function(master_name) {
    logger.debug('Loaded cluster: '+master_name);
    this.emit('cluster_ready', master_name);
};
Monitor.prototype.sync_complete = function() {
    logger.debug('Synced with sentinel '+this.current_sentinel.host+':'+this.current_sentinel.port);
    this.synced = true;
    for (var i = 0; i < this.master_clients.length; ++i){
        var client = this.master_clients[i];
        if (!client.host){
            var config = this.masters[master_name];
            if (!config) 
                client.onSync(null, null, null);
            else{
                var port = parseInt(config.port);
                var host = config.ip;
                var slaves = this.slaves[master_name];
                client.onSync(port, host, slaves);
            }            
        }
    }
    this.emit('synced');
};
Monitor.prototype.sentinel_selected = function() {
    logger.debug('Selected sentinel');
    this.emit('sentinel_selected');
};

/**** PubSub Event Handlers ****/
Monitor.prototype.on_obj_down = function(info) {
    logger.info('Sentinel reports '+info.type+' '+info.name+' is down');
    if (info.type == 'master' && this.master_clients[info.name]) 
        this.get_client(info.name).enter_failsafe_state();
    else if (info.type == 'slave') {
        this.remove_slave(info.port, info.host, info.master_name);
    }
}

Monitor.prototype.on_obj_up = function(info) {
    logger.info('Sentinel reports '+info.type+' '+info.name+' is up');
    if (info.type == 'master' && this.master_clients[info.name]) 
        this.get_client(info.name).exit_failsafe_state(info);
    else if (info.type == 'sentinel')
        this.add_sentinel(info.port, info.host);
    else if (info.type == 'slave')
        this.add_slave(info.port, info.host, info.master_name);
}

// change these for different behavior on +-subdown
Monitor.prototype.on_sub_down = function(info) {
    this.on_obj_down(info);
}
Monitor.prototype.on_sub_up = function(info) {
    this.on_obj_up(info);
}

Monitor.prototype.on_new_slave = function(info) {
    //this.load_slave_list(info.master_name);
    this.add_slave(info.port, info.host, info.master_name);
}

Monitor.prototype.on_new_sentinel = function(info) {
    this.add_sentinel(info.port, info.host);
}

Monitor.prototype.on_reboot_instance = function(info) {
    //TODO: may not actually need this one
    logger.debug('reboot instance args: ' + info.toString());
}

Monitor.prototype.on_switch_master = function(debug){
    // TODO: may not actually need this one
    logger.debug('switch master args: ' + info.toString());
}

/**** Utility Functions ****/
/**
 *  Calls the appropriate message handler for the sentinel channel on a publish event.
 *
 *  NOTE: the pattern param is a placeholder and is not being used at all
 */
function handle_sentinel_message(pattern, channel, message) {
    if ( !(message && typeof message.data == 'string') ) return;
    logger.debug('Handling pub/sub message: '+channel+' '+message);

    var handler = this.SUBSCRIPTION_HANDLES[channel];
    if ( typeof handler != 'function' ) return;
    handler( parse_instance_info(message.data) );
}

/**
 *  Parses the space-delimited values returned by redis pubsub into a hash.
 *
 *  @param {string} info_str The string response from sentinel pubsub.
 *  @return {Object} The object hash mapping the values to what they represent on a redis instance.
 */
function parse_instance_info(infoStr) {
    var tokens = infoStr.split(' ');
    var info = {
        type: tokens[0],
        name: tokens[1],
        host: tokens[2],
        port: tokens[3]
    };

    if (info.type == 'slave') info.master_name = tokens[5];
    return info;
}

/**
 *  Turns an array of sequential key value pairs into a hash
 *
 *  f/e: ['x', 2, 'y', 3] => { x: 2, y: 3 }
 *
 *  @param {Array} arr The array to be unflattened.
 *  @return {Object} The unflattened array.
 */
function unflatten_hash(arr) {
    var out = {};
    for (var i = 0; i < arr.length; i += 2) {
        out[arr[i]] = arr[i + 1];
    }

    return out;
}

function get_client_index(port, host, client_config_array) {
    var index = -1;
    client_config_array.forEach(function(client, c_index) {
        if (client.port == port && (client.host || client.ip) == host) index = c_index;
    })
    return index;
}
