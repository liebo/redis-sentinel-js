var net = require('net');
var redis = require('redis');
var logger = require('./logger.js');
var CommandQueue = require('./command_queue.js');

module.exports = MasterClient;

/**
 * A redis cluster abstraction which is initialized as a connection to a master instance.
 * If the connection fails, it queues writes and sends reads to a selected slave instance.
 *
 * @param {string} master_name The name given to the clister by the sentinels.
 * @param {number} master_port The port of the master redis instance.
 * @param {string} master_host The host of the master redis instance.
 * @param {Array} slaves The array of configuration info for the slave instances.
 * @param {number} timeout Milliseconds to hold queued requests while waiting to exit failsafe state. Requests will
 *                          resolve with an error after the timeout finishes.
 */
function MasterClient( master_name, master_port, master_host, slaves, timeout ) {

    if( !arguments.length ) return;

    this.name = master_name;
    this.failover_timeout = timeout || 5000;
    
    onSync(master_port, master_host, slaves);
}

MasterClient.prototype.__proto__ = redis.RedisClient.prototype;

MasterClient.prototype.onSync = function(master_port, master_host, slaves){
    if (master_host){
        this.slaves = slaves;
        var net_client = net.createConnection( master_port, master_host );
        redis.RedisClient.call( this, net_client );
        this.host = master_host;
        this.port = master_port;
        this.listen_for_errors();
        if (this.cq)
            this.consume_command_queue();
    }else{
        this.generate_command_queue();
    }
}

MasterClient.prototype.listen_for_errors = function() {
    if (this._events && this._events.error && this._events.error.length) return;
    this.on('error', function(e) {
        logger.error(e.message);
        this.enter_failsafe_state();
        // send any commands waiting in the offline_queue
        this.send_offline_queue();
    });
}

MasterClient.prototype.enter_failsafe_state = function(next) {
    next = next || none;
    if (this.cq) return next();
    logger.warn('Master client: '+this.name+' entering failsafe');
    this.generate_command_queue();
    this.connect_to_valid_slave(0, next);
    this.emit('+failsafe');
};

MasterClient.prototype.exit_failsafe_state = function(new_master_config) {
    if (!this.cq) return;
    delete this.failsafe_state;
    logger.info('Master client '+this.name+' exiting failsafe');
    this.connect_to_redis_instance( new_master_config.port, new_master_config.host );
    this.once( 'connect', function() {
        logger.info(
            'Master client: '+this.name+' connected to '+new_master_config.host+':'+new_master_config.port
        );
        this.consume_command_queue();
        this.emit('-failsafe');
    });
};

MasterClient.prototype.connect_to_valid_slave = function(num_trials, next) {
    this.failsafe_state = 'rw';

    // arbitrary upper bound chosen to account for slaves being altered while fallback is taking place
    if (num_trials < this.slaves.length + 3) {
        this._connect_to_slave(num_trials, next);
    } else {
        next();
    }
};

MasterClient.prototype._connect_to_slave = function (num_trials, next) {
    var slave_index = num_trials % (this.slaves.length || 1);
    var slave = this.slaves[slave_index];
    if(!slave) return this.connect_to_valid_slave(num_trials + 1, next);

    this.connect_to_redis_instance( slave.port, slave.ip );
    this.once('error', on_error);
    this.once('connect', on_connect);
    function on_error() {
        this.on_slave_error(slave, num_trials, next);
    }
    function on_connect() {
        this.on_slave_connect(slave, num_trials, next);
    }
};
MasterClient.prototype.on_slave_error = function (slave, num_trials, next) {
    logger.warn('Master client: '+this.name+' failed to connect to slave: '+slave.ip+':'+slave.port);
    this.removeAllListeners('connect');
    this.connect_to_valid_slave(num_trials + 1, next);
}
MasterClient.prototype.on_slave_connect = function (slave, num_trials, next) {
    logger.info('Master client: '+this.name+' connected to slave: '+slave.ip+':'+slave.port);
    this.removeAllListeners('error');
    this.listen_for_errors();
    this.failsafe_state = 'w';
    this.cq.exec_reads();
    next();
}

/**
 * Reconnect the MasterClient to the specified port/host combo.
 *
 * Deletes the old stream object and creates a new one, reassigning all necessary
 * events to it.
 *
 * @param {number} port
 * @param {string} host
 */
MasterClient.prototype.connect_to_redis_instance = function( port, host ) {
    var self = this;
    //this.options = {no_ready_check: true};
    this.stream.removeAllListeners();
    this.port = port;
    this.host = host;
    this.ready = false;
    this.connected = false;
    this.stream = net.createConnection(port, host);

    // add handles to the new stream necessary to reconnect
    this.stream.on("connect", this.on_connect.bind(this));
    this.stream.on("data", this.on_data.bind(this));
    this.stream.on("error", this.on_error.bind(this));
    this.stream.on("close", this.connection_gone.bind(this, "close"));
    this.stream.on("end", this.connection_gone.bind(this, "end"));
    this.stream.on("drain", function () {
        self.should_buffer = false;
        self.emit("drain");
    });
};

// Store the original send_command
MasterClient.prototype.super_send_command = redis.RedisClient.prototype.send_command;

// Create a new send_command with middleware to handle failures
MasterClient.prototype.send_command = function(command, args, next, trials) {
    trials = trials || 0; // track number of retries
    if (typeof args[args.length-1] == 'function') next = args.pop();
    else if (typeof next != 'function') next = function(){};

    // check failsafe_state instead of cq.  It reads better
    if (this.cq) this.send_command_with_failsafe(command, args, next, trials);
    else this.send_command_without_failsafe(command, args, next, trials);
};

/**
 * Route the command to the command queue or a slave.
 */
MasterClient.prototype.send_command_with_failsafe = function(command, args, next) {
    var self = this;
    if (is_write_command(command) || this.failsafe_state == 'rw')
        return this.cq[command](args, next);

    this.super_send_command(command, args, function(error, response) {
        if (error) self.connect_to_valid_slave( 0, function() {
            self.send_command(command, args, next);
        });
        else next(error, response); 
    });
};

/**
 * Route command to super with appropriate middleware to handle failures.
 */
MasterClient.prototype.send_command_without_failsafe = function(command, args, next, trials) {
    var self = this;
    this.super_send_command(command, args, function( error, response ) {
        // TODO: how many trials will we allow before deciding the process has failed beyond recovery?
        if (error && trials < 1) {
            return self.enter_failsafe_state( function() {
                self.send_command(command, args, next);
            });
        }
        else if (error) return self.send_command(command, args, next, trials + 1);

        next(error, response);
    });
};

/**
 * Creates a new command queue. Overridden for mocking in test.
 */
MasterClient.prototype.generate_command_queue = function() {
    this.cq = new CommandQueue(this);
};
/**
 * Delete the command queue and consume queued commands
 */
MasterClient.prototype.consume_command_queue = function() {
    var cq = this.cq;
    delete this.cq;
    cq.exec();
};

function none(){}

/**
 * Returns true if the command would perform a write to redis
 */
// TODO: use the command queue version of this instead
function is_write_command(command) {
    return /(pop)|(set)|(del)/i.test(command);
}
