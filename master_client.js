var net = require('net');
var redis = require('redis');
var CommandQueue = require('./command_queue.js');

module.exports = MasterClient;
// Since this is an eventer, maybe use events to determine whether it enters failsafe
function MasterClient( master_name, master_port, master_host, slaves, timeout ) {

    this.name = master_name;
    this.failover_timeout = timeout || 5000;
    this.slaves = slaves;

    var net_client = net.createConnection(master_port, master_host);
    redis.RedisClient.call( this, net_client );
    this.on('end', function() {
        this.enter_failsafe_state();
    });

}

MasterClient.prototype.__proto__ = redis.RedisClient.prototype;

MasterClient.prototype.enter_failsafe_state = function(next) {
    next = next || none;
    if (this.cq) return;
    this.generate_command_queue();
    this.connect_to_valid_slave(next);
    this.emit('+failsafe');
}

MasterClient.prototype.exit_failsafe_state = function(new_master_config) {
    if (!this.cq) return;
    delete this.failsafe_state;
    this.connect_to_redis_instance( new_master_config.port, new_master_config.host );
    this.once( 'connect', function() {
        this.consume_command_queue();
        this.emit('-failsafe');
    });
}

MasterClient.prototype.connect_to_valid_slave = function(num_trials, next) {
    var self = this;
    this.failsafe_state = 'w';
    if (typeof num_trials == 'function') {
        next = num_trials;
        num_trials = 0;
    }
    num_trials = num_trials || 0;

    // using the square of num slaves as the upper bound for number of random slaves
    // to try.
    if (num_trials < this.slaves.length * this.slaves.length) {
        var slave = this.slaves[Math.floor(Math.random() * this.slaves.length)];
        this.connect_to_redis_instance( slave.port, slave.ip );
        this.ping( function(error, response) {
            if (error) self.connect_to_valid_slave(num_trials + 1, next);
            else self.failsafe_state = 'w';
        });
    } else {
        this.failsafe_state = 'rw';
    }
    next();
}

MasterClient.prototype.connect_to_redis_instance = function( port, host ) {
    var self = this;
    this.options = {no_ready_check: true};
    this.stream.removeAllListeners();
    this.port = port;
    this.host = host;
    this.stream = net.createConnection(port, host);

    this.stream.on("connect", this.on_connect.bind(this));
    this.stream.on("data", this.on_data.bind(this));
    this.stream.on("error", this.on_error.bind(this));
    this.stream.on("close", this.connection_gone.bind(this, "close"));
    this.stream.on("end", this.connection_gone.bind(this, "end"));
    this.stream.on("drain", function () {
        self.should_buffer = false;
        self.emit("drain");
    });
}

MasterClient.prototype.super_send_command = redis.RedisClient.prototype.send_command;
MasterClient.prototype.send_command = function(command, args, next, trials) {
    trials = trials || 0;
    if (typeof args[args.length-1] == 'function') next = args.pop();
    else if (typeof next != 'function') next = function(){};

    if (this.cq) this.send_command_with_failsafe(command, args, next, trials);
    else this.send_command_without_failsafe(command, args, next, trials);
}

MasterClient.prototype.send_command_with_failsafe = function(command, args, next, trials) {
    var self = this;
    if (is_write_command(command) || this.failsafe_state == 'rw')
        return this.cq[command](args, next);

    this.super_send_command(command, args, function(error, response) {
        if (error) self.connect_to_valid_slave( 0, function() {
            self.send_command(command, args, next);
        });
        else next(error, response); 
    });
}

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
}

MasterClient.prototype.generate_command_queue = function() {
    this.cq = new CommandQueue(this);
}
MasterClient.prototype.consume_command_queue = function() {
    var cq = this.cq;
    delete this.cq;
    cq.exec();
}

function none(){}

function is_write_command(command) {
    return /(pop)|(set)|(del)/i.test(command);
}
